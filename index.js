#!/usr/bin/env node
/* eslint-disable no-console */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { stop, start, status } from './features/lifecycle.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pipeline } from '@xenova/transformers';
import fs from 'fs/promises';
import path from 'path';

import { createRequire } from 'module';

// Import package.json for version
const require = createRequire(import.meta.url);
const packageJson = require('./package.json');

import { loadConfig, getGlobalCacheDir } from './lib/config.js';

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

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function logMemory(prefix) {
  const { rss, heapUsed, heapTotal } = process.memoryUsage();
  console.error(
    `${prefix} rss=${formatMb(rss)} heap=${formatMb(heapUsed)}/${formatMb(heapTotal)}`
  );
}

// Log cache directory logic for debugging
try {
  const globalCache = path.join(getGlobalCacheDir(), 'heuristic-mcp');
  const localCache = path.join(process.cwd(), '.heuristic-mcp');
  console.error(`[Server] Cache debug: Global=${globalCache}, Local=${localCache}`);
  console.error(`[Server] Process CWD: ${process.cwd()}`);
} catch (_e) { /* ignore */ }

// Parse workspace from command line arguments
let args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(packageJson.version);
  process.exit(0);
}

const hadLogs = args.includes('--logs');
if (hadLogs) {
  process.env.SMART_CODING_VERBOSE = 'true';
  args = args.filter((arg) => arg !== '--logs');
  console.log('[Logs] Starting server with verbose console output (Ctrl+C to stop)...');
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
async function initialize() {
  // Load configuration with workspace support
  config = await loadConfig(workspaceDir);

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
  console.error('[Server] Initializing features...');
  let cachedEmbedder = null;
  const lazyEmbedder = async (...args) => {
    if (!cachedEmbedder) {
      console.error(`[Server] Loading AI embedding model: ${config.embeddingModel}...`);
      cachedEmbedder = await pipeline('feature-extraction', config.embeddingModel);
      if (config.verbose) {
        logMemory('[Server] Memory (after model load)');
      }
    }
    return cachedEmbedder(...args);
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
  console.error(`[Server] Cache directory: ${config.cacheDirectory}`);
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
  console.error('[Server] Starting background indexing...');
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
async function main() {
  await initialize();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[Server] Heuristic MCP server ready!');
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.error('\n[Server] Shutting down gracefully...');

  // Stop file watcher
  if (indexer && indexer.watcher) {
    await indexer.watcher.close();
    console.error('[Server] File watcher stopped');
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
    console.error('[Server] Cache saved');
  }

  console.error('[Server] Goodbye!');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('\n[Server] Received SIGTERM, shutting down...');

  // Stop file watcher
  if (indexer && indexer.watcher) {
    await indexer.watcher.close();
    console.error('[Server] File watcher stopped');
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
    console.error('[Server] Cache saved');
  }

  console.error('[Server] Goodbye!');
  process.exit(0);
});

main().catch(console.error);
