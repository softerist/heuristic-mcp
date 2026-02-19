import { loadConfig } from '../lib/config.js';
import { EmbeddingsCache } from '../lib/cache.js';
import { CodebaseIndexer } from '../features/index-codebase.js';
import { CacheClearer } from '../features/clear-cache.js';
import { HybridSearch } from '../features/hybrid-search.js';
import { pipeline } from '@huggingface/transformers';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

let sharedEmbedder = null;

const DEFAULT_MOCK_DIMENSIONS = 64;

export async function getEmbedder(config) {
  if (!sharedEmbedder) {
    if (config.verbose) {
      console.error('[TestHelper] Loading embedding model (first time)...');
    }
    sharedEmbedder = await pipeline('feature-extraction', config.embeddingModel);
    if (config.verbose) {
      console.error('[TestHelper] Embedding model loaded');
    }
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
    const tokens = String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .filter((token) => token.length > 1);

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

export async function createTestFixtures(options = {}) {
  const sessionId = crypto.randomBytes(6).toString('hex');
  const tempRootDir = path.join(os.tmpdir(), `heuristic-mcp-test-${sessionId}`);
  const searchDir = path.join(tempRootDir, 'project');
  const cacheDir = path.join(tempRootDir, 'cache');

  await fs.mkdir(searchDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

  await fs.writeFile(
    path.join(searchDir, 'test.js'),
    'function hello() {\n  console.info("hello world");\n}\n\n// embedder CodebaseIndexer test fixture\nmodule.exports = { hello };'
  );
  await fs.writeFile(
    path.join(searchDir, 'utils.py'),
    'def add(a, b):\n    """Adds two numbers"""\n    return a + b\n\nif __name__ == "__main__":\n    print(add(2, 3))'
  );
  await fs.writeFile(path.join(searchDir, 'README.md'), '# Test Project\n\nThis is a test.');

  const config = await loadConfig();

  config.searchDirectory = searchDir;
  config.cacheDirectory = cacheDir;

  if (options.verbose !== undefined) config.verbose = options.verbose;
  if (options.workerThreads !== undefined) config.workerThreads = options.workerThreads;
  if (isVitest() && options.forceWorkers !== true) config.workerThreads = 0;
  if (options.clearCacheAfterIndex !== undefined) {
    config.clearCacheAfterIndex = options.clearCacheAfterIndex;
  } else {
    config.clearCacheAfterIndex = false;
  }

  if (isVitest() && options.forceEmbeddingProcessPerBatch !== true) {
    config.embeddingProcessPerBatch = false;
    config.autoEmbeddingProcessPerBatch = false;
  }

  config.unloadModelAfterSearch = false;

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
    tempRootDir,
    searchDir,
    cacheDir,
    config,
    embedder,
    cache,
    indexer,
    cacheClearer,
    hybridSearch,
  };
}

export async function cleanupFixtures(fixtures) {
  if (fixtures.indexer) {
    fixtures.indexer.terminateWorkers();
    if (fixtures.indexer.watcher) {
      await fixtures.indexer.watcher.close();
    }
  }

  if (fixtures.tempRootDir) {
    try {
      await fs.rm(fixtures.tempRootDir, { recursive: true, force: true });
    } catch (err) {}
  }
}

export async function clearTestCache(config) {
  try {
    await fs.rm(config.cacheDirectory, { recursive: true, force: true });
  } catch (err) {}
}

export function createMockRequest(toolName, args = {}) {
  return {
    params: {
      name: toolName,
      arguments: args,
    },
  };
}

export function createHybridSearchCacheStub({ vectorStore = [], ...overrides } = {}) {
  let store = vectorStore;
  const base = {
    getVectorStore: () => store,
    setVectorStore: (next) => {
      store = Array.isArray(next) ? next : [];
    },
    getStoreSize: () => store.length,
    getVector: (idx) => store[idx]?.vector ?? null,
    getChunk: (idx) => store[idx] ?? null,
    getChunkContent: async (chunkOrIndex) => {
      if (typeof chunkOrIndex === 'number') {
        return store[chunkOrIndex]?.content ?? null;
      }
      return chunkOrIndex?.content ?? null;
    },
    getChunkVector: (chunkOrIndex) => {
      if (typeof chunkOrIndex === 'number') {
        return store[chunkOrIndex]?.vector ?? null;
      }
      return chunkOrIndex?.vector ?? null;
    },
    queryAnn: async () => null,
    getRelatedFiles: async () => new Map(),
    getFileMeta: () => null,
    startRead: () => {},
    endRead: () => {},
    waitForReaders: async () => {},
  };

  return { ...base, ...overrides };
}

export async function waitFor(condition, timeout = 5000, interval = 100) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

export async function measureTime(fn) {
  const start = Date.now();
  const result = await fn();
  const duration = Date.now() - start;
  return { result, duration };
}
