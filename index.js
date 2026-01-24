#!/usr/bin/env node
/* eslint-disable no-console */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { stop, start, status, logs } from './features/lifecycle.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pipeline } from '@xenova/transformers';
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

import { loadConfig, getGlobalCacheDir } from './lib/config.js';
import { ensureLogDirectory } from './lib/logging.js';

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
  log: console.log,
  warn: console.warn,
  error: console.error,
};

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function logMemory(prefix) {
  const { rss, heapUsed, heapTotal } = process.memoryUsage();
  console.error(
    `${prefix} rss=${formatMb(rss)} heap=${formatMb(heapUsed)}/${formatMb(heapTotal)}`
  );
}

function printHelp() {
  console.log(`Heuristic MCP Server

Usage:
  heuristic-mcp [options]

Options:
  --status                 Show server and cache status
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
      const current = fsSync.readFileSync(pidPath, 'utf-8').trim();
      if (current === `${process.pid}`) {
        fsSync.unlinkSync(pidPath);
      }
    } catch {
      // ignore
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

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
      const timestamp = new Date().toISOString();
      const lines = message.split(/\r?\n/);
      const payload =
        lines.map((line) => `${timestamp} [${level}] ${line}`).join('\n') + '\n';
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
  const pidPath = await setupPidFile();
  const logPath = await setupFileLogging(config);
  if (logPath) {
    console.log(`[Logs] Writing server logs to ${logPath}`);
    console.log(`[Logs] Log viewer: heuristic-mcp --logs --workspace "${config.searchDirectory}"`);
  }
  if (pidPath) {
    console.log(`[Server] PID file: ${pidPath}`);
  }

  // Log cache directory logic for debugging
  try {
    const globalCache = path.join(getGlobalCacheDir(), 'heuristic-mcp');
    const localCache = path.join(process.cwd(), '.heuristic-mcp');
    console.log(`[Server] Cache debug: Global=${globalCache}, Local=${localCache}`);
    console.log(`[Server] Process CWD: ${process.cwd()}`);
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
  console.log('[Server] Initializing features...');
  let cachedEmbedderPromise = null;
  const lazyEmbedder = async (...args) => {
    if (!cachedEmbedderPromise) {
      console.log(`[Server] Loading AI embedding model: ${config.embeddingModel}...`);
      cachedEmbedderPromise = pipeline('feature-extraction', config.embeddingModel).then((model) => {
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

  // In verbose mode, we trigger an early load to provide immediate resource feedback
  if (config.verbose) {
    embedder('').catch((err) => {
      // Ignore "text may not be null" errors as we are just pre-warming
      if (!err.message.includes('text may not be null')) {
        console.error(`[Server] Warning: Early model load failed: ${err.message}`);
      }
    });
  }

  // Initialize cache
  cache = new EmbeddingsCache(config);
  console.log(`[Server] Cache directory: ${config.cacheDirectory}`);
  await cache.load();
  if (config.verbose) {
    logMemory('[Server] Memory (after cache load)');
  }
  if (startupMemoryTimer) {
    clearInterval(startupMemoryTimer);
  }

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

  // Start indexing in background (non-blocking)
  console.log('[Server] Starting background indexing...');
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
  // Parse workspace from command line arguments
  let args = argv.slice(2);
  const rawArgs = [...args];

  if (args.includes('--version') || args.includes('-v')) {
    console.log(packageJson.version);
    process.exit(0);
  }

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const wantsLogs = args.includes('--logs');
  const wantsNoFollow = args.includes('--no-follow');
  let tailLines = DEFAULT_LOG_TAIL_LINES;
  if (wantsLogs) {
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
    await status();
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

  const workspaceIndex = args.findIndex((arg) => arg.startsWith('--workspace'));
  let workspaceDir = null;

  if (workspaceIndex !== -1) {
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
      workspaceDir = process.cwd();
    } else if (rawWorkspace) {
      workspaceDir = rawWorkspace;
    }

    if (workspaceDir) {
      console.error(`[Server] Workspace mode: ${workspaceDir}`);
    }
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

  await initialize(workspaceDir);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.log('[Server] Heuristic MCP server ready!');
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Server] Shutting down gracefully...');

  // Stop file watcher
  if (indexer && indexer.watcher) {
    await indexer.watcher.close();
    console.log('[Server] File watcher stopped');
  }

  // Give workers time to finish current batch (prevents core dump)
  if (indexer && indexer.terminateWorkers) {
    try {
      console.log('[Server] Waiting for workers to finish...');
      await new Promise((resolve) => setTimeout(resolve, 500));
      await indexer.terminateWorkers();
      console.log('[Server] Workers terminated');
    } catch (_err) {
      // Suppress native module errors during shutdown
      console.log('[Server] Workers shutdown (with warnings)');
    }
  }

  // Save cache
  if (cache) {
    await cache.save();
    console.log('[Server] Cache saved');
  }

  console.log('[Server] Goodbye!');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Server] Received SIGTERM, shutting down...');

  // Stop file watcher
  if (indexer && indexer.watcher) {
    await indexer.watcher.close();
    console.log('[Server] File watcher stopped');
  }

  // Give workers time to finish current batch (prevents core dump)
  if (indexer && indexer.terminateWorkers) {
    try {
      console.error('[Server] Waiting for workers to finish...');
      await new Promise((resolve) => setTimeout(resolve, 500));
      await indexer.terminateWorkers();
      console.error('[Server] Workers terminated');
    } catch (_err) {
      // Suppress native module errors during shutdown
      console.error('[Server] Workers shutdown (with warnings)');
    }
  }

  // Save cache
  if (cache) {
    await cache.save();
    console.log('[Server] Cache saved');
  }

  console.log('[Server] Goodbye!');
  process.exit(0);
});

const isMain = process.argv[1] && (
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() ||
  process.argv[1].endsWith('heuristic-mcp') ||
  process.argv[1].endsWith('heuristic-mcp.js') ||
  path.basename(process.argv[1]) === 'index.js'
);

if (isMain) {
  main().catch(console.error);
}
