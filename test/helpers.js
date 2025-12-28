/**
 * Test helper utilities for Heuristic MCP tests
 * Provides shared setup, teardown, and mock utilities
 */

import { loadConfig } from '../lib/config.js';
import { EmbeddingsCache } from '../lib/cache.js';
import { CodebaseIndexer } from '../features/index-codebase.js';
import { CacheClearer } from '../features/clear-cache.js';
import { HybridSearch } from '../features/hybrid-search.js';
import { pipeline } from '@xenova/transformers';
import fs from 'fs/promises';
import path from 'path';

// Cached embedder instance (shared across tests for speed)
let sharedEmbedder = null;

const DEFAULT_MOCK_DIMENSIONS = 64;

/**
 * Get or initialize the shared embedder instance
 * Loading the model once and reusing saves significant time
 */
export async function getEmbedder(config) {
  if (!sharedEmbedder) {
    console.log('[TestHelper] Loading embedding model (first time)...');
    sharedEmbedder = await pipeline('feature-extraction', config.embeddingModel);
    console.log('[TestHelper] Embedding model loaded');
  }
  return sharedEmbedder;
}

function isVitest() {
  return Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID);
}

function hashToken(token) {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

function normalizeVector(vector) {
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i++) {
    sumSquares += vector[i] * vector[i];
  }
  if (sumSquares === 0) {
    vector[0] = 1;
    return vector;
  }
  const norm = Math.sqrt(sumSquares);
  for (let i = 0; i < vector.length; i++) {
    vector[i] /= norm;
  }
  return vector;
}

function createMockEmbedder({ dimensions = DEFAULT_MOCK_DIMENSIONS } = {}) {
  return async (text, options = {}) => {
    const vector = new Float32Array(dimensions);
    const tokens = String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .filter(token => token.length > 1);

    for (const token of tokens) {
      const index = hashToken(token) % dimensions;
      const weight = 1 + Math.min(4, Math.floor(token.length / 4));
      vector[index] += weight;
    }

    if (options.normalize) {
      normalizeVector(vector);
    }

    return { data: vector };
  };
}

/**
 * Create test fixtures with initialized components
 * @param {Object} options - Options for fixture creation
 * @returns {Object} Initialized components for testing
 */
export async function createTestFixtures(options = {}) {
  const config = await loadConfig();

  // Override config for testing if needed
  if (options.verbose !== undefined) config.verbose = options.verbose;
  if (options.workerThreads !== undefined) config.workerThreads = options.workerThreads;
  if (isVitest()) config.workerThreads = 1;

  const useRealEmbedder = options.useRealEmbedder === true;
  const embedder = useRealEmbedder
    ? await getEmbedder(config)
    : createMockEmbedder({ dimensions: options.embeddingDimensions });

  const cache = new EmbeddingsCache(config);
  await cache.load();

  const indexer = new CodebaseIndexer(embedder, cache, config, null);
  const cacheClearer = new CacheClearer(embedder, cache, config, indexer);
  const hybridSearch = new HybridSearch(embedder, cache, config);

  return {
    config,
    embedder,
    cache,
    indexer,
    cacheClearer,
    hybridSearch
  };
}

/**
 * Clean up test resources
 * @param {Object} fixtures - Test fixtures to clean up
 */
export async function cleanupFixtures(fixtures) {
  if (fixtures.indexer) {
    fixtures.indexer.terminateWorkers();
    if (fixtures.indexer.watcher) {
      await fixtures.indexer.watcher.close();
    }
  }
}

/**
 * Clear the cache directory for a clean test state
 * @param {Object} config - Configuration object
 */
export async function clearTestCache(config) {
  try {
    await fs.rm(config.cacheDirectory, { recursive: true, force: true });
  } catch (err) {
    // Ignore if doesn't exist
  }
}

/**
 * Create a mock MCP request object
 * @param {string} toolName - Tool name
 * @param {Object} args - Tool arguments
 * @returns {Object} Mock request object
 */
export function createMockRequest(toolName, args = {}) {
  return {
    params: {
      name: toolName,
      arguments: args
    }
  };
}

/**
 * Wait for a condition with timeout
 * @param {Function} condition - Async function returning boolean
 * @param {number} timeout - Max wait time in ms
 * @param {number} interval - Check interval in ms
 * @returns {boolean} Whether condition was met
 */
export async function waitFor(condition, timeout = 5000, interval = 100) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return true;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return false;
}

/**
 * Measure execution time of an async function
 * @param {Function} fn - Async function to measure
 * @returns {Object} Result and duration
 */
export async function measureTime(fn) {
  const start = Date.now();
  const result = await fn();
  const duration = Date.now() - start;
  return { result, duration };
}
