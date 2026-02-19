#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { stop, start, status, logs } from './features/lifecycle.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
let transformersModule = null;
async function getTransformers() {
  if (!transformersModule) {
    transformersModule = await import('@huggingface/transformers');
  }
  return transformersModule;
}
import { configureNativeOnnxBackend, getNativeOnnxStatus } from './lib/onnx-backend.js';

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// Import package.json for version
const require = createRequire(import.meta.url);
const packageJson = require('./package.json');

import { loadConfig, getGlobalCacheDir } from './lib/config.js';
import { clearStaleCaches } from './lib/cache-utils.js';
import { enableStderrOnlyLogging, setupFileLogging, getLogFilePath } from './lib/logging.js';
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
import * as PackageVersionFeature from './features/package-version.js';
import * as SetWorkspaceFeature from './features/set-workspace.js';
import { handleListResources, handleReadResource } from './features/resources.js';
import { getWorkspaceEnvKeys } from './lib/workspace-env.js';

import {
  MEMORY_LOG_INTERVAL_MS,
  ONNX_THREAD_LIMIT,
  BACKGROUND_INDEX_DELAY_MS,
} from './lib/constants.js';
const PID_FILE_NAME = '.heuristic-mcp.pid';

async function readLogTail(logPath, maxLines = 2000) {
  const data = await fs.readFile(logPath, 'utf-8');
  if (!data) return [];
  const lines = data.split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines);
}

async function printMemorySnapshot(workspaceDir) {
  const activeConfig = await loadConfig(workspaceDir);
  const logPath = getLogFilePath(activeConfig);

  let lines;
  try {
    lines = await readLogTail(logPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`[Memory] No log file found for workspace.`);
      console.error(`[Memory] Expected location: ${logPath}`);
      console.error(
        '[Memory] Start the server with verbose logging (set "verbose": true), then try again.'
      );
      return false;
    }
    console.error(`[Memory] Failed to read log file: ${err.message}`);
    return false;
  }

  const memoryLines = lines.filter((line) => /Memory\s*\(/.test(line) || /Memory.*rss=/.test(line));
  if (memoryLines.length === 0) {
    console.info('[Memory] No memory snapshots found in logs.');
    console.info('[Memory] Ensure "verbose": true in config and restart the server.');
    return true;
  }

  const idleLine =
    [...memoryLines].reverse().find((line) => line.includes('after cache load')) ??
    memoryLines[memoryLines.length - 1];

  const logLine = (line) => {
    console.info(line);
    if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
      console.error(line);
    }
  };

  logLine(`[Memory] Idle snapshot: ${idleLine}`);

  const latestLine = memoryLines[memoryLines.length - 1];
  if (latestLine !== idleLine) {
    logLine(`[Memory] Latest snapshot: ${latestLine}`);
  }

  return true;
}

// Arguments parsed in main()

// Global state
let embedder = null;
let unloadMainEmbedder = null; // Function to unload the embedding model
let cache = null;
let indexer = null;
let hybridSearch = null;
let config = null;
let setWorkspaceFeatureInstance = null;
let autoWorkspaceSwitchPromise = null;

async function resolveWorkspaceFromEnvValue(rawValue) {
  if (!rawValue || rawValue.includes('${')) return null;
  const resolved = path.resolve(rawValue);
  try {
    const stats = await fs.stat(resolved);
    if (!stats.isDirectory()) return null;
    return resolved;
  } catch {
    return null;
  }
}

async function detectRuntimeWorkspaceFromEnv() {
  for (const key of getWorkspaceEnvKeys()) {
    const workspacePath = await resolveWorkspaceFromEnvValue(process.env[key]);
    if (workspacePath) {
      return { workspacePath, envKey: key };
    }
  }

  return null;
}

async function maybeAutoSwitchWorkspace(request) {
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') return;
  if (!setWorkspaceFeatureInstance || !config?.searchDirectory) return;
  if (request?.params?.name === 'f_set_workspace') return;

  const detected = await detectRuntimeWorkspaceFromEnv();
  if (!detected) return;

  const currentWorkspace = path.resolve(config.searchDirectory);
  if (detected.workspacePath === currentWorkspace) return;

  if (autoWorkspaceSwitchPromise) {
    await autoWorkspaceSwitchPromise;
    return;
  }

  autoWorkspaceSwitchPromise = (async () => {
    console.info(
      `[Server] Auto-switching workspace from ${currentWorkspace} to ${detected.workspacePath} (env ${detected.envKey})`
    );
    const result = await setWorkspaceFeatureInstance.execute({
      workspacePath: detected.workspacePath,
      reindex: false,
    });
    if (!result.success) {
      console.warn(
        `[Server] Auto workspace switch failed (env ${detected.envKey}): ${result.error}`
      );
    }
  })();

  try {
    await autoWorkspaceSwitchPromise;
  } finally {
    autoWorkspaceSwitchPromise = null;
  }
}

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
  {
    module: PackageVersionFeature,
    instance: null,
    handler: PackageVersionFeature.handleToolCall,
  },
  {
    module: SetWorkspaceFeature,
    instance: null,
    handler: null, // Late-bound after initialization
  },
];

// Initialize application
async function initialize(workspaceDir) {
  // Load configuration with workspace support
  config = await loadConfig(workspaceDir);
  
  // Automatic cache cleanup on startup (Option A)
  if (config.enableCache && config.cacheCleanup?.autoCleanup) {
    console.info('[Server] Running automatic cache cleanup...');
    const results = await clearStaleCaches({
      ...config.cacheCleanup,
      logger: console,
    });
    if (results.removed > 0) {
      console.info(`[Server] Removed ${results.removed} stale cache ${results.removed === 1 ? 'directory' : 'directories'}`);
    }
  }
  
  // Skip gc check during tests (VITEST env is set)
  const isTest = Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID);
  if (config.enableExplicitGc && typeof global.gc !== 'function' && !isTest) {
    console.warn(
      '[Server] enableExplicitGc=true but this process was not started with --expose-gc; continuing with explicit GC disabled.'
    );
    console.warn(
      '[Server] Tip: start with "npm start" or add --expose-gc to enable explicit GC again.'
    );
    config.enableExplicitGc = false;
  }

  let mainBackendConfigured = false;
  let nativeOnnxAvailable = null;
  const ensureMainOnnxBackend = () => {
    if (mainBackendConfigured) return;
    nativeOnnxAvailable = configureNativeOnnxBackend({
      log: config.verbose ? console.info : null,
      label: '[Server]',
      threads: {
        intraOpNumThreads: ONNX_THREAD_LIMIT,
        interOpNumThreads: 1,
      },
    });
    mainBackendConfigured = true;
  };

  ensureMainOnnxBackend();
  if (nativeOnnxAvailable === false) {
    try {
      const { env } = await getTransformers();
      if (env?.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = ONNX_THREAD_LIMIT;
      }
    } catch {
      // ignore: fallback tuning is best effort
    }
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
    setupPidFile({ pidFileName: PID_FILE_NAME, cacheDirectory: config.cacheDirectory }),
    setupFileLogging(config),
  ]);
  if (logPath) {
    console.info(`[Logs] Writing server logs to ${logPath}`);
    console.info(`[Logs] Log viewer: heuristic-mcp --logs --workspace "${config.searchDirectory}"`);
  }
  {
    const resolution = config.workspaceResolution || {};
    const sourceLabel =
      resolution.source === 'env' && resolution.envKey
        ? `env:${resolution.envKey}`
        : resolution.source || 'unknown';
    const baseLabel = resolution.baseDirectory || '(unknown)';
    const searchLabel = resolution.searchDirectory || config.searchDirectory;
    const overrideLabel = resolution.searchDirectoryFromConfig ? 'yes' : 'no';
    console.info(
      `[Server] Workspace resolved: source=${sourceLabel}, base=${baseLabel}, search=${searchLabel}, configOverride=${overrideLabel}`
    );
    if (resolution.fromPath) {
      console.info(`[Server] Workspace resolution origin cwd: ${resolution.fromPath}`);
    }
  }

  // Log effective configuration for debugging
  console.info(
    `[Server] Config: workerThreads=${config.workerThreads}, embeddingProcessPerBatch=${config.embeddingProcessPerBatch}`
  );
  console.info(
    `[Server] Config: vectorStoreLoadMode=${config.vectorStoreLoadMode}, vectorCacheEntries=${config.vectorCacheEntries}`
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
    console.info(`[Server] Resolved workspace: ${config.searchDirectory} (via ${config.workspaceResolution?.source || 'unknown'})`);
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
      const { pipeline } = await getTransformers();
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
  
  // Unload the main process embedding model to free memory
  const unloader = async () => {
    if (!cachedEmbedderPromise) return false;
    try {
      const model = await cachedEmbedderPromise;
      if (model && typeof model.dispose === 'function') {
        await model.dispose();
      }
      cachedEmbedderPromise = null;
      if (typeof global.gc === 'function') {
        global.gc();
      }
      if (config.verbose) {
        logMemory('[Server] Memory (after model unload)');
      }
      console.info('[Server] Embedding model unloaded to free memory.');
      return true;
    } catch (err) {
      console.warn(`[Server] Error unloading embedding model: ${err.message}`);
      cachedEmbedderPromise = null;
      return false;
    }
  };
  
  embedder = lazyEmbedder;
  unloadMainEmbedder = unloader; // Store in module scope for tool handler access
  const preloadEmbeddingModel = async () => {
    if (config.preloadEmbeddingModel === false) return;
    try {
      console.info('[Server] Preloading embedding model (background)...');
      await embedder(' ');
    } catch (err) {
      console.warn(`[Server] Embedding model preload failed: ${err.message}`);
    }
  };

  // NOTE: We no longer auto-load in verbose mode when preloadEmbeddingModel=false.
  // The model will be loaded lazily on first search or by child processes during indexing.

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
  // Features 5 (PackageVersion) doesn't need instance

  // Initialize SetWorkspace feature with shared state
  const setWorkspaceInstance = new SetWorkspaceFeature.SetWorkspaceFeature(
    config,
    cache,
    indexer,
    getGlobalCacheDir
  );
  setWorkspaceFeatureInstance = setWorkspaceInstance;
  features[6].instance = setWorkspaceInstance;
  features[6].handler = SetWorkspaceFeature.createHandleToolCall(setWorkspaceInstance);

  // Attach hybridSearch to server for cross-feature access (e.g. cache invalidation)
  server.hybridSearch = hybridSearch;

  const startBackgroundTasks = async () => {
    // Keep startup responsive: do not block server readiness on model preload.
    void preloadEmbeddingModel();

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
    }, BACKGROUND_INDEX_DELAY_MS);
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

// Handle resources/list
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return await handleListResources(config);
});

// Handle resources/read
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  return await handleReadResource(request.params.uri, config);
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
  await maybeAutoSwitchWorkspace(request);

  for (const feature of features) {
    const toolDef = feature.module.getToolDefinition(config);

    if (request.params.name === toolDef.name) {
      // Safety check: handler may be null if initialization is incomplete
      if (typeof feature.handler !== 'function') {
        return {
          content: [{
            type: 'text',
            text: `Tool "${toolDef.name}" is not ready. Server may still be initializing.`,
          }],
          isError: true,
        };
      }
      const result = await feature.handler(request, feature.instance);
      
      // Unload embedding model after search-related tools to free memory
      // Tools that use embedder: a_semantic_search, d_find_similar_code
      const searchTools = ['a_semantic_search', 'd_find_similar_code'];
      if (config.unloadModelAfterSearch && searchTools.includes(toolDef.name)) {
        // Defer unload slightly to not block response, use setImmediate for non-blocking
        setImmediate(async () => {
          if (typeof unloadMainEmbedder === 'function') {
            await unloadMainEmbedder();
          }
        });
      }
      
      return result;
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: `Unknown tool: ${request.params.name}`,
      },
    ],
    isError: true,
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
    wantsMem,
    wantsNoFollow,
    tailLines,
    wantsStop,
    wantsStart,
    wantsCache,
    wantsClean,
    wantsStatus,
    wantsClearCache,
    startFilter,
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


  if (wantsStop) {
    await stop();
    process.exit(0);
  }

  if (wantsStart) {
    await start(startFilter);
    process.exit(0);
  }

  if (wantsStatus) {
    await status({ fix: wantsFix, workspaceDir });
    process.exit(0);
  }

  // --cache command (cache-only, no server status)
  if (wantsCache) {
    await status({ fix: wantsClean, cacheOnly: true, workspaceDir });
    process.exit(0);
  }

  // --clear <cache_id> command (remove specific cache by ID)
  const clearIndex = parsed.rawArgs.indexOf('--clear');
  if (clearIndex !== -1) {
    const cacheId = parsed.rawArgs[clearIndex + 1];
    if (cacheId && !cacheId.startsWith('--')) {
      // Remove specific cache by ID
      // Determine platform-appropriate cache directory
      let cacheHome;
      if (process.platform === 'win32') {
        cacheHome = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      } else if (process.platform === 'darwin') {
        cacheHome = path.join(os.homedir(), 'Library', 'Caches');
      } else {
        cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
      }
      const globalCacheRoot = path.join(cacheHome, 'heuristic-mcp');
      const trimmedId = String(cacheId).trim();
      const hasSeparators = trimmedId.includes('/') || trimmedId.includes('\\');
      const resolvedCachePath = path.resolve(globalCacheRoot, trimmedId);
      const relPath = path.relative(globalCacheRoot, resolvedCachePath);
      const isWithinRoot = relPath && !relPath.startsWith('..') && !path.isAbsolute(relPath);

      if (!trimmedId || hasSeparators || !isWithinRoot) {
        console.error(`[Cache] ❌ Invalid cache id: ${cacheId}`);
        console.error('[Cache] Cache id must be a direct child of the cache root.');
        process.exit(1);
      }

      const cachePath = resolvedCachePath;
      
      try {
        await fs.access(cachePath);
        console.info(`[Cache] Removing cache: ${cacheId}`);
        console.info(`[Cache] Path: ${cachePath}`);
        await fs.rm(cachePath, { recursive: true, force: true });
        console.info(`[Cache] ✅ Successfully removed cache ${cacheId}`);
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.error(`[Cache] ❌ Cache not found: ${cacheId}`);
          console.error(`[Cache] Available caches in ${globalCacheRoot}:`);
          const dirs = await fs.readdir(globalCacheRoot).catch(() => []);
          dirs.forEach(dir => console.error(`   - ${dir}`));
          process.exit(1);
        } else {
          console.error(`[Cache] ❌ Failed to remove cache: ${error.message}`);
          process.exit(1);
        }
      }
      process.exit(0);
    }
    // If --clear with no arg, fall through to --clear-cache behavior
  }

  if (wantsClearCache) {
    await clearCache(workspaceDir);
    process.exit(0);
  }

  if (wantsLogs) {
    process.env.SMART_CODING_LOGS = 'true';
    process.env.SMART_CODING_VERBOSE = 'true';
    await logs({
      workspaceDir,
      tailLines,
      follow: !wantsNoFollow,
    });
    process.exit(0);
  }

  if (wantsMem) {
    const ok = await printMemorySnapshot(workspaceDir);
    process.exit(ok ? 0 : 1);
  }

  if (unknownFlags.length > 0) {
    console.error(`[Error] Unknown option(s): ${unknownFlags.join(', ')}`);
    printHelp();
    process.exit(1);
  }

  if (wantsFix && !wantsStatus) {
    console.error('[Error] --fix can only be used with --status (deprecated, use --cache --clean)');
    printHelp();
    process.exit(1);
  }

  if (wantsClean && !wantsCache) {
    console.error('[Error] --clean can only be used with --cache');
    printHelp();
    process.exit(1);
  }

  registerSignalHandlers(requestShutdown);
  // NOTE: We intentionally do NOT shut down on stdin close.
  // When an IDE restarts, it may briefly close stdin then reconnect.
  // The server should remain running to preserve cache and be ready for reconnection.
  // Use SIGINT/SIGTERM or --stop command for intentional shutdown.
  const { startBackgroundTasks } = await initialize(workspaceDir);

  // (Blocking init moved below)

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.info('[Server] MCP transport connected.');
  console.info('[Server] Heuristic MCP server started.');

  // Load cache and start indexing in background AFTER server is ready
  void startBackgroundTasks().catch((err) => {
    console.error(`[Server] Background task error: ${err.message}`);
  });
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
