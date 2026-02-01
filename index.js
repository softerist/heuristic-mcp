#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { stop, start, status, logs } from './features/lifecycle.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { pipeline, env } from '@huggingface/transformers';
import { configureNativeOnnxBackend, getNativeOnnxStatus } from './lib/onnx-backend.js';

import fs from 'fs/promises';
import path from 'path';

import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// Import package.json for version
const require = createRequire(import.meta.url);
const packageJson = require('./package.json');

import { loadConfig, getGlobalCacheDir } from './lib/config.js';
import { clearStaleCaches } from './lib/cache-utils.js';
import { enableStderrOnlyLogging, setupFileLogging } from './lib/logging.js';
import { parseArgs, printHelp } from './lib/cli.js';
import { clearCache } from './lib/cache-ops.js';
import { logMemory, startMemoryLogger } from './lib/memory-logger.js';
import {
  registerSignalHandlers,
  setupPidFile,
  acquireWorkspaceLock,
} from './lib/server-lifecycle.js';

import { EmbeddingsCache } from './lib/cache.js';
import { CodebaseIndexer } from './features/index-codebase.js';
import { HybridSearch } from './features/hybrid-search.js';

import * as IndexCodebaseFeature from './features/index-codebase.js';
import * as HybridSearchFeature from './features/hybrid-search.js';
import * as ClearCacheFeature from './features/clear-cache.js';
import * as FindSimilarCodeFeature from './features/find-similar-code.js';
import * as AnnConfigFeature from './features/ann-config.js';
import { register } from './features/register.js';

const MEMORY_LOG_INTERVAL_MS = 15000;
const PID_FILE_NAME = '.heuristic-mcp.pid';

// Arguments parsed in main()

// Global state
let embedder = null;
let cache = null;
let indexer = null;
let hybridSearch = null;
let config = null;

// Feature registry - ordered by priority (semantic_search first as primary tool)
const features = [
  {
    module: HybridSearchFeature,
    instance: null,
    handler: HybridSearchFeature.handleToolCall,
  },
  {
    module: IndexCodebaseFeature,
    instance: null,
    handler: IndexCodebaseFeature.handleToolCall,
  },
  {
    module: ClearCacheFeature,
    instance: null,
    handler: ClearCacheFeature.handleToolCall,
  },
  {
    module: FindSimilarCodeFeature,
    instance: null,
    handler: FindSimilarCodeFeature.handleToolCall,
  },
  {
    module: AnnConfigFeature,
    instance: null,
    handler: AnnConfigFeature.handleToolCall,
  },
];

// Initialize application
async function initialize(workspaceDir) {
  // Load configuration with workspace support
  config = await loadConfig(workspaceDir);
  if (config.enableCache && config.autoCleanStaleCaches !== false) {
    await clearStaleCaches();
  }
  if (config.enableExplicitGc && typeof global.gc !== 'function') {
    console.error(
      '[Server] FATAL: enableExplicitGc=true but this process was not started with --expose-gc.'
    );
    console.error(
      '[Server] Please start the server using "npm start" or add --expose-gc to your node command.'
    );
    process.exit(1);
  }

  const onnxThreadLimit = 2;
  let mainBackendConfigured = false;
  let nativeOnnxAvailable = null;
  const ensureMainOnnxBackend = () => {
    if (mainBackendConfigured) return;
    nativeOnnxAvailable = configureNativeOnnxBackend({
      log: config.verbose ? console.info : null,
      label: '[Server]',
      threads: {
        intraOpNumThreads: onnxThreadLimit,
        interOpNumThreads: 1,
      },
    });
    if (!nativeOnnxAvailable && env?.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = onnxThreadLimit;
    }
    mainBackendConfigured = true;
  };

  ensureMainOnnxBackend();
  if (nativeOnnxAvailable === false) {
    const status = getNativeOnnxStatus();
    const reason = status?.message || 'onnxruntime-node not available';
    console.warn(`[Server] Native ONNX backend unavailable (${reason}); using WASM backend.`);
    console.warn(
      '[Server] Auto-safety: disabling workers and forcing embeddingProcessPerBatch for memory isolation.'
    );
    if (config.workerThreads !== 0) {
      config.workerThreads = 0;
    }
    if (!config.embeddingProcessPerBatch) {
      config.embeddingProcessPerBatch = true;
    }
  }
  const lock = await acquireWorkspaceLock({
    cacheDirectory: config.cacheDirectory,
    workspaceDir: config.searchDirectory,
  });
  if (!lock.acquired) {
    console.warn(
      `[Server] Another heuristic-mcp instance is already running for this workspace (pid ${lock.ownerPid ?? 'unknown'}).`
    );
    console.warn('[Server] Exiting to avoid duplicate model loads.');
    process.exit(0);
  }
  const [pidPath, logPath] = await Promise.all([
    setupPidFile({ pidFileName: PID_FILE_NAME }),
    setupFileLogging(config),
  ]);
  if (logPath) {
    console.info(`[Logs] Writing server logs to ${logPath}`);
    console.info(`[Logs] Log viewer: heuristic-mcp --logs --workspace "${config.searchDirectory}"`);
  }

  // Log effective configuration for debugging
  console.info(
    `[Server] Config: workerThreads=${config.workerThreads}, embeddingProcessPerBatch=${config.embeddingProcessPerBatch}`
  );

  if (pidPath) {
    console.info(`[Server] PID file: ${pidPath}`);
  }

  // Log cache directory logic for debugging
  try {
    const globalCache = path.join(getGlobalCacheDir(), 'heuristic-mcp');
    const localCache = path.join(process.cwd(), '.heuristic-mcp');
    console.info(`[Server] Cache debug: Global=${globalCache}, Local=${localCache}`);
    console.info(`[Server] Process CWD: ${process.cwd()}`);
  } catch (_e) {
    /* ignore */
  }

  let stopStartupMemory = null;
  if (config.verbose) {
    logMemory('[Server] Memory (startup)');
    stopStartupMemory = startMemoryLogger('[Server] Memory (startup)', MEMORY_LOG_INTERVAL_MS);
  }

  // Ensure search directory exists
  try {
    await fs.access(config.searchDirectory);
  } catch {
    console.error(`[Server] Error: Search directory "${config.searchDirectory}" does not exist`);
    process.exit(1);
  }

  // Create a transparent lazy-loading embedder closure
  console.info('[Server] Initializing features...');
  let cachedEmbedderPromise = null;
  const lazyEmbedder = async (...args) => {
    if (!cachedEmbedderPromise) {
      ensureMainOnnxBackend();
      console.info(`[Server] Loading AI embedding model: ${config.embeddingModel}...`);
      const modelLoadStart = Date.now();
      cachedEmbedderPromise = pipeline('feature-extraction', config.embeddingModel, {
        quantized: true,
        dtype: 'fp32',
        session_options: {
          numThreads: 2,
          intraOpNumThreads: 2,
          interOpNumThreads: 2,
        },
      }).then((model) => {
        const loadSeconds = ((Date.now() - modelLoadStart) / 1000).toFixed(1);
        console.info(
          `[Server] Embedding model loaded (${loadSeconds}s). Starting intensive indexing (expect high CPU)...`
        );
        console.info(`[Server] Embedding model ready: ${config.embeddingModel}`);
        if (config.verbose) {
          logMemory('[Server] Memory (after model load)');
        }
        return model;
      });
    }
    const model = await cachedEmbedderPromise;
    return model(...args);
  };
  embedder = lazyEmbedder;
  let embedderPreloaded = false;

  // Preload the embedding model to ensure deterministic startup logs
  if (config.preloadEmbeddingModel !== false) {
    try {
      console.info('[Server] Preloading embedding model...');
      await embedder(' ');
      embedderPreloaded = true;
    } catch (err) {
      console.warn(`[Server] Embedding model preload failed: ${err.message}`);
    }
  }

  // In verbose mode, we trigger an early load to provide immediate resource feedback
  if (config.verbose && !embedderPreloaded) {
    embedder('').catch((err) => {
      // Ignore "text may not be null" errors as we are just pre-warming
      if (!err.message.includes('text may not be null')) {
        console.error(`[Server] Warning: Early model load failed: ${err.message}`);
      }
    });
  }

  // Initialize cache (load deferred until after server is ready)
  cache = new EmbeddingsCache(config);
  console.info(`[Server] Cache directory: ${config.cacheDirectory}`);

  // Initialize features
  indexer = new CodebaseIndexer(embedder, cache, config, server);
  hybridSearch = new HybridSearch(embedder, cache, config);
  const cacheClearer = new ClearCacheFeature.CacheClearer(embedder, cache, config, indexer);
  const findSimilarCode = new FindSimilarCodeFeature.FindSimilarCode(embedder, cache, config);
  const annConfig = new AnnConfigFeature.AnnConfigTool(cache, config);

  // Store feature instances (matches features array order)
  features[0].instance = hybridSearch;
  features[1].instance = indexer;
  features[2].instance = cacheClearer;
  features[3].instance = findSimilarCode;
  features[4].instance = annConfig;

  // Attach hybridSearch to server for cross-feature access (e.g. cache invalidation)
  server.hybridSearch = hybridSearch;

  const startBackgroundTasks = async () => {
    try {
      console.info('[Server] Loading cache (deferred)...');
      await cache.load();
      if (config.verbose) {
        logMemory('[Server] Memory (after cache load)');
      }
    } finally {
      if (stopStartupMemory) {
        stopStartupMemory();
      }
    }

    // Start indexing in background (non-blocking)
    console.info('[Server] Starting background indexing (delayed)...');

    // Slight delay to allow server to bind and accept first request if immediate
    setTimeout(() => {
      indexer
        .indexAll()
        .then(() => {
          // Only start file watcher if explicitly enabled in config
          if (config.watchFiles) {
            indexer.setupFileWatcher();
          }
        })
        .catch((err) => {
          console.error('[Server] Background indexing error:', err.message);
        });
    }, 3000);
  };

  return { startBackgroundTasks, config };
}

// Setup MCP server
const server = new Server(
  {
    name: 'heuristic-mcp',
    version: packageJson.version,
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// Handle resources/list (required by some IDEs even if we have no resources)
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: [] };
});

// Register tools from all features
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [];

  for (const feature of features) {
    const toolDef = feature.module.getToolDefinition(config);
    tools.push(toolDef);
  }

  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  for (const feature of features) {
    const toolDef = feature.module.getToolDefinition(config);

    if (request.params.name === toolDef.name) {
      return await feature.handler(request, feature.instance);
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: `Unknown tool: ${request.params.name}`,
      },
    ],
  };
});

// Main entry point
export async function main(argv = process.argv) {
  const parsed = parseArgs(argv);
  const {
    isServerMode,
    workspaceDir,
    wantsVersion,
    wantsHelp,
    wantsLogs,
    wantsNoFollow,
    tailLines,
    wantsStop,
    wantsStart,
    wantsStatus,
    wantsClearCache,
    wantsRegister,
    registerFilter,
    wantsFix,
    unknownFlags,
  } = parsed;

  let shutdownRequested = false;
  const requestShutdown = (reason) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    console.info(`[Server] Shutdown requested (${reason}).`);
    void gracefulShutdown(reason);
  };

  if (isServerMode && !(process.env.VITEST === 'true' || process.env.NODE_ENV === 'test')) {
    enableStderrOnlyLogging();
  }
  if (wantsVersion) {
    console.info(packageJson.version);
    process.exit(0);
  }

  if (wantsHelp) {
    printHelp();
    process.exit(0);
  }

  if (workspaceDir) {
    console.info(`[Server] Workspace mode: ${workspaceDir}`);
  }

  if (wantsLogs) {
    process.env.SMART_CODING_LOGS = 'true';
    process.env.SMART_CODING_VERBOSE = 'true';
    console.info('[Server] Starting server with verbose logging enabled');
  }

  if (wantsStop) {
    await stop();
    process.exit(0);
  }

  if (wantsStart) {
    await start();
    process.exit(0);
  }

  if (wantsStatus) {
    await status({ fix: wantsFix });
    process.exit(0);
  }

  if (wantsClearCache) {
    await clearCache(workspaceDir);
    process.exit(0);
  }

  if (wantsRegister) {
    await register(registerFilter);
    process.exit(0);
  }

  if (wantsLogs) {
    await logs({
      workspaceDir,
      tailLines,
      follow: !wantsNoFollow,
    });
    process.exit(0);
  }

  if (unknownFlags.length > 0) {
    console.error(`[Error] Unknown option(s): ${unknownFlags.join(', ')}`);
    printHelp();
    process.exit(1);
  }

  if (wantsFix && !wantsStatus) {
    console.error('[Error] --fix can only be used with --status');
    printHelp();
    process.exit(1);
  }

  registerSignalHandlers(gracefulShutdown);
  if (isServerMode && !(process.env.VITEST === 'true' || process.env.NODE_ENV === 'test')) {
    const handleStdinClose = () => requestShutdown('stdin');
    process.stdin?.on('end', handleStdinClose);
    process.stdin?.on('close', handleStdinClose);
    process.stdin?.on('error', handleStdinClose);
  }
  const { startBackgroundTasks } = await initialize(workspaceDir);

  // (Blocking init moved below)

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.info('[Server] MCP transport connected.');
  console.info('[Server] Heuristic MCP server started.');

  // Load cache and start indexing in background AFTER server is ready
  startBackgroundTasks().catch((err) => {
    console.error(`[Server] Background task error: ${err.message}`);
  });

  console.info('[Server] Heuristic MCP server started.');
  console.info('[Server] MCP server is now fully ready to accept requests.');
}

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.info(`[Server] Received ${signal}, shutting down gracefully...`);

  const cleanupTasks = [];

  // Stop file watcher
  if (indexer && indexer.watcher) {
    cleanupTasks.push(
      indexer.watcher
        .close()
        .then(() => console.info('[Server] File watcher stopped'))
        .catch(() => console.warn('[Server] Error closing watcher'))
    );
  }

  // Give workers time to finish current batch
  if (indexer && indexer.terminateWorkers) {
    cleanupTasks.push(
      (async () => {
        console.info('[Server] Terminating workers...');
        await indexer.terminateWorkers();
        console.info('[Server] Workers terminated');
      })().catch(() => console.info('[Server] Workers shutdown (with warnings)'))
    );
  }

  // Save cache
  if (cache) {
    cleanupTasks.push(
      cache
        .save()
        .then(() => console.info('[Server] Cache saved'))
        .catch((err) => console.error(`[Server] Failed to save cache: ${err.message}`))
    );
  }

  await Promise.allSettled(cleanupTasks);
  console.info('[Server] Goodbye!');

  // Allow stdio buffers to flush
  setTimeout(() => process.exit(0), 100);
}

const isMain =
  process.argv[1] &&
  (path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() ||
    process.argv[1].endsWith('heuristic-mcp') ||
    process.argv[1].endsWith('heuristic-mcp.js') ||
    path.basename(process.argv[1]) === 'index.js') &&
  !(process.env.VITEST === 'true' || process.env.NODE_ENV === 'test');

if (isMain) {
  main().catch(console.error);
}
