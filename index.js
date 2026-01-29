#!/usr/bin/env node
/* eslint-disable no-console */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { stop, start, status, logs } from './features/lifecycle.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pipeline, env } from '@xenova/transformers';

// Limit ONNX threads to prevent CPU saturation (tuned to 2 for balanced load)
if (env?.backends?.onnx) {
  env.backends.onnx.numThreads = 2;
  if (env.backends.onnx.wasm) {
    env.backends.onnx.wasm.numThreads = 2;
  }
}
import fs from 'fs/promises';
import fsSync, { createWriteStream } from 'fs';
import path from 'path';
import util from 'util';
import os from 'os';

import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// Import package.json for version
const require = createRequire(import.meta.url);
const packageJson = require('./package.json');

const BUILD_SIGNATURE = `[Server] Local build: ${fileURLToPath(import.meta.url)}`;

import { loadConfig, getGlobalCacheDir } from './lib/config.js';
import { ensureLogDirectory } from './lib/logging.js';
import { clearStaleCaches } from './lib/cache-utils.js';

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
const DEFAULT_LOG_TAIL_LINES = 200;
const PID_FILE_NAME = '.heuristic-mcp.pid';

let logStream = null;
let originalConsole = {
  log: console.info,
  warn: console.warn,
  error: console.error,
  info: console.info,
};

function enableStderrOnlyLogging() {
  // Keep MCP stdout clean by routing all console output to stderr.
  const redirect = (...args) => originalConsole.error(...args);
  console.log = redirect; console.info = redirect;
  console.warn = redirect;
  console.error = redirect;
  console.log = redirect; console.info = redirect;
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function logMemory(prefix) {
  const { rss, heapUsed, heapTotal } = process.memoryUsage();
  console.info(
    `${prefix} rss=${formatMb(rss)} heap=${formatMb(heapUsed)}/${formatMb(heapTotal)}`
  );
}

function printHelp() {
  console.info(`Heuristic MCP Server

Usage:
  heuristic-mcp [options]

Options:
  --status                 Show server and cache status
  --fix                    With --status, remove stale cache directories
  --clear-cache            Remove cache for current workspace (and stale global caches)
  --logs                   Tail server logs (defaults to last 200 lines, follows)
  --tail <lines>           Lines to show with --logs (default: ${DEFAULT_LOG_TAIL_LINES})
  --no-follow              Do not follow log output with --logs
  --start                  Ensure IDE config is registered (does not start server)
  --stop                   Stop running server instances
  --register [ide]         Register MCP server with IDE (antigravity|cursor|"Claude Desktop")
  --workspace <path>       Workspace path (used by IDE launch / log viewer)
  --version, -v            Show version
  --help, -h               Show this help
`);
}

async function setupPidFile() {
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
    return null;
  }

  const pidPath = path.join(os.homedir(), PID_FILE_NAME);
  try {
    await fs.writeFile(pidPath, `${process.pid}`, 'utf-8');
  } catch (err) {
    console.error(`[Server] Warning: Failed to write PID file: ${err.message}`);
    return null;
  }

  const cleanup = () => {
    try {
      fsSync.unlinkSync(pidPath);
    } catch {
      // ignore
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  return pidPath;
}

async function setupFileLogging(activeConfig) {
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
    return null;
  }

  try {
    const logPath = await ensureLogDirectory(activeConfig);
    logStream = createWriteStream(logPath, { flags: 'a' });

    const writeLine = (level, args) => {
      if (!logStream) return;
      const message = util.format(...args);
      // Skip empty lines (spacers) in log files
      if (!message.trim()) return;

      const timestamp = new Date().toISOString();
      const lines = message
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
      if (lines.length === 0) return;
      const payload = lines.map((line) => `${timestamp} [${level}] ${line}`).join('\n') + '\n';
      logStream.write(payload);
    };

    const wrap = (method, level) => {
      const originalError = originalConsole.error;
      console[method] = (...args) => {
        // Always send to original stderr to avoid MCP protocol pollution on stdout
        originalError(...args);
        writeLine(level, args);
      };
    };

    wrap('log', 'INFO');
    wrap('warn', 'WARN');
    wrap('error', 'ERROR');
    wrap('info', 'INFO');

    logStream.on('error', (err) => {
      originalConsole.error(`[Logs] Failed to write log file: ${err.message}`);
    });

    process.on('exit', () => {
      if (logStream) logStream.end();
    });

    return logPath;
  } catch (err) {
    originalConsole.error(`[Logs] Failed to initialize log file: ${err.message}`);
    return null;
  }
}

function parseWorkspaceDir(args) {
  const workspaceIndex = args.findIndex((arg) => arg.startsWith('--workspace'));
  if (workspaceIndex === -1) return null;

  const arg = args[workspaceIndex];
  let rawWorkspace = null;

  if (arg.includes('=')) {
    rawWorkspace = arg.split('=')[1];
  } else if (workspaceIndex + 1 < args.length) {
    rawWorkspace = args[workspaceIndex + 1];
  }

  // Check if IDE variable wasn't expanded (contains ${})
  if (rawWorkspace && rawWorkspace.includes('${')) {
    console.error(`[Server] IDE variable not expanded: ${rawWorkspace}, using current directory`);
    return process.cwd();
  }

  return rawWorkspace || null;
}

async function clearCache(workspaceDir) {
  const effectiveWorkspace = workspaceDir || process.cwd();
  const activeConfig = await loadConfig(effectiveWorkspace);

  if (!activeConfig.enableCache) {
    console.info('[Cache] Cache disabled (enableCache=false); nothing to clear.');
    return;
  }

  try {
    await fs.rm(activeConfig.cacheDirectory, { recursive: true, force: true });
    console.info(`[Cache] Cleared cache directory: ${activeConfig.cacheDirectory}`);
    await clearStaleCaches();
  } catch (err) {
    console.error(`[Cache] Failed to clear cache: ${err.message}`);
    process.exit(1);
  }
}

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
  const [pidPath, logPath] = await Promise.all([
    setupPidFile(),
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
  } catch (_e) { /* ignore */ }

  let startupMemoryTimer = null;
  if (config.verbose) {
    logMemory('[Server] Memory (startup)');
    startupMemoryTimer = setInterval(
      () => logMemory('[Server] Memory (startup)'),
      MEMORY_LOG_INTERVAL_MS
    );
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
      console.info(`[Server] Loading AI embedding model: ${config.embeddingModel}...`);
      const modelLoadStart = Date.now();
      cachedEmbedderPromise = pipeline('feature-extraction', config.embeddingModel, {
        quantized: true,
        session_options: {
          numThreads: 2,
          intraOpNumThreads: 2,
          interOpNumThreads: 2,
        },
      }).then((model) => {
        const loadSeconds = ((Date.now() - modelLoadStart) / 1000).toFixed(1);
        console.info(
          `[Server] Embedding model loaded (${loadSeconds}s). Starting intensive indexing (expect high CPU)...`,
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
  try {
    console.info('[Server] Preloading embedding model...');
    await embedder(' ');
    embedderPreloaded = true;
  } catch (err) {
    console.warn(`[Server] Embedding model preload failed: ${err.message}`);
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
      if (startupMemoryTimer) {
        clearInterval(startupMemoryTimer);
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

  return { startBackgroundTasks };
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
    },
  }
);

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
  let args = argv.slice(2);
  const isServerMode = !(args.includes('--status') || args.includes('--clear-cache') || args.includes('--logs') || args.includes('--start') || args.includes('--stop') || args.includes('--register') || args.includes('--help') || args.includes('-h') || args.includes('--version') || args.includes('-v'));
  if (isServerMode && !(process.env.VITEST === 'true' || process.env.NODE_ENV === 'test')) {
    enableStderrOnlyLogging();
  }
  console.info(BUILD_SIGNATURE);
  console.info(`[Server] argv: ${argv.join(' ')}`);
  // Parse workspace from command line arguments
  const rawArgs = [...args];

  if (args.includes('--version') || args.includes('-v')) {
    console.info(packageJson.version);
    process.exit(0);
  }

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const workspaceDir = parseWorkspaceDir(args);
  if (workspaceDir) {
    console.info(`[Server] Workspace mode: ${workspaceDir}`);
  }

  const wantsLogs = args.includes('--logs');
  const wantsNoFollow = args.includes('--no-follow');
  let tailLines = DEFAULT_LOG_TAIL_LINES;
  if (wantsLogs) {
    process.env.SMART_CODING_LOGS = 'true';
    process.env.SMART_CODING_VERBOSE = 'true';
    console.info('[Server] Starting server with verbose logging enabled');

    const tailIndex = args.indexOf('--tail');
    if (tailIndex !== -1 && args[tailIndex + 1]) {
      const parsed = parseInt(args[tailIndex + 1], 10);
      if (!isNaN(parsed) && parsed > 0) {
        tailLines = parsed;
      }
    }
  }

  if (args.includes('--stop')) {
    await stop();
    process.exit(0);
  }

  if (args.includes('--start')) {
    await start();
    process.exit(0);
  }

  if (args.includes('--status')) {
    await status({ fix: args.includes('--fix') });
    process.exit(0);
  }

  if (args.includes('--clear-cache')) {
    await clearCache(workspaceDir);
    process.exit(0);
  }

  // Check if --register flag is present
  if (args.includes('--register')) {
    // Extract optional filter (e.g. --register antigravity)
    const filterIndex = args.indexOf('--register');
    const filter =
      args[filterIndex + 1] && !args[filterIndex + 1].startsWith('-') ? args[filterIndex + 1] : null;

    await register(filter);
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

  const knownFlags = new Set([
    '--status',
    '--fix',
    '--clear-cache',
    '--logs',
    '--tail',
    '--no-follow',
    '--start',
    '--stop',
    '--register',
    '--workspace',
    '--version',
    '-v',
    '--help',
    '-h',
  ]);
  const flagsWithValue = new Set(['--tail', '--workspace', '--register']);
  const unknownFlags = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (flagsWithValue.has(arg)) {
      if (arg.includes('=')) continue;
      const next = rawArgs[i + 1];
      if (next && !next.startsWith('-')) {
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('-') && !knownFlags.has(arg) && !arg.startsWith('--workspace=')) {
      unknownFlags.push(arg);
    }
  }
  if (unknownFlags.length > 0) {
    console.error(`[Error] Unknown option(s): ${unknownFlags.join(', ')}`);
    printHelp();
    process.exit(1);
  }

  if (args.includes('--fix') && !args.includes('--status')) {
    console.error('[Error] --fix can only be used with --status');
    printHelp();
    process.exit(1);
  }


  const { startBackgroundTasks } = await initialize(workspaceDir);

  // Load cache before connecting to ensure tools are ready
  await startBackgroundTasks();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.info('[Server] MCP transport connected.');
  console.info('[Server] Heuristic MCP server started.');
  console.info('[Server] MCP server is now fully ready to accept requests.');
}

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.info(`[Server] Received ${signal}, shutting down gracefully...`);

  // Stop file watcher
  if (indexer && indexer.watcher) {
    try {
      await indexer.watcher.close();
      console.info('[Server] File watcher stopped');
    } catch (_err) {
      console.warn('[Server] Error closing watcher');
    }
  }

  // Give workers time to finish current batch
  if (indexer && indexer.terminateWorkers) {
    try {
      console.info('[Server] Terminating workers...');
      await indexer.terminateWorkers();
      console.info('[Server] Workers terminated');
    } catch (_err) {
      // Suppress native module errors during shutdown
      console.info('[Server] Workers shutdown (with warnings)');
    }
  }

  // Save cache
  if (cache) {
    try {
      await cache.save();
      console.info('[Server] Cache saved');
    } catch (err) {
      console.error(`[Server] Failed to save cache: ${err.message}`);
    }
  }

  console.info('[Server] Goodbye!');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

const isMain = process.argv[1] && (
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() ||
  process.argv[1].endsWith('heuristic-mcp') ||
  process.argv[1].endsWith('heuristic-mcp.js') ||
  path.basename(process.argv[1]) === 'index.js'
);

if (isMain) {
  main().catch(console.error);
}
