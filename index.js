#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pipeline } from "@xenova/transformers";
import fs from "fs/promises";

import { loadConfig } from "./lib/config.js";
import { EmbeddingsCache } from "./lib/cache.js";
import { CodebaseIndexer } from "./features/index-codebase.js";
import { HybridSearch } from "./features/hybrid-search.js";

import * as IndexCodebaseFeature from "./features/index-codebase.js";
import * as HybridSearchFeature from "./features/hybrid-search.js";
import * as ClearCacheFeature from "./features/clear-cache.js";

// Global state
let embedder = null;
let cache = null;
let indexer = null;
let hybridSearch = null;
let config = null;

// Feature registry
const features = [
  {
    module: IndexCodebaseFeature,
    instance: null,
    handler: IndexCodebaseFeature.handleToolCall
  },
  {
    module: HybridSearchFeature,
    instance: null,
    handler: HybridSearchFeature.handleToolCall
  },
  {
    module: ClearCacheFeature,
    instance: null,
    handler: ClearCacheFeature.handleToolCall
  }
];

// Initialize application
async function initialize() {
  // Load configuration
  config = await loadConfig();
  
  // Ensure search directory exists
  try {
    await fs.access(config.searchDirectory);
  } catch {
    console.error(`[Server] Error: Search directory "${config.searchDirectory}" does not exist`);
    process.exit(1);
  }

  // Load AI model
  console.error("[Server] Loading AI embedding model (this may take time on first run)...");
  embedder = await pipeline("feature-extraction", config.embeddingModel);

  // Initialize cache
  cache = new EmbeddingsCache(config);
  await cache.load();

  // Initialize features
  indexer = new CodebaseIndexer(embedder, cache, config);
  hybridSearch = new HybridSearch(embedder, cache, config);
  const cacheClearer = new ClearCacheFeature.CacheClearer(embedder, cache, config);

  // Store feature instances
  features[0].instance = indexer;
  features[1].instance = hybridSearch;
  features[2].instance = cacheClearer;

  // Index codebase
  await indexer.initialize();
}

// Setup MCP server
const server = new Server(
  { 
    name: "smart-coding-mcp", 
    version: "1.0.0" 
  },
  { 
    capabilities: { 
      tools: {} 
    } 
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
    content: [{
      type: "text",
      text: `Unknown tool: ${request.params.name}`
    }]
  };
});

// Main entry point
async function main() {
  await initialize();
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error("[Server] Smart Coding MCP server ready!");
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.error("\n[Server] Shutting down gracefully...");
  
  // Stop file watcher
  if (indexer && indexer.watcher) {
    await indexer.watcher.close();
    console.error("[Server] File watcher stopped");
  }
  
  // Save cache
  if (cache) {
    await cache.save();
    console.error("[Server] Cache saved");
  }
  
  console.error("[Server] Goodbye!");
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error("\n[Server] Received SIGTERM, shutting down...");
  process.exit(0);
});

main().catch(console.error);