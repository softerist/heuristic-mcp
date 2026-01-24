import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const makeConfig = (cacheDir) => ({
  cacheDirectory: cacheDir,
  searchDirectory: cacheDir,
  enableCache: true,
  callGraphEnabled: false,
  embeddingModel: 'test-model',
  fileExtensions: ['js'],
  excludePatterns: [],
  annEnabled: true,
  annMinChunks: 1,
  annMetric: 'cosine',
  annM: 48,
  annEfConstruction: 200,
  annEfSearch: 10,
  annIndexCache: true,
  verbose: true,
});

async function withTempDir(testFn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heuristic-cache-branches-'));
  try {
    await testFn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('EmbeddingsCache branch coverage', () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('logs when HierarchicalNSW export is missing', async () => {
    await withTempDir(async (dir) => {
      vi.doMock('hnswlib-node', () => ({ default: {} }));
      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache(makeConfig(dir));
      cache.vectorStore = [{ vector: [1, 2, 3] }];

      const result = await cache.ensureAnnIndex();

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('hnswlib-node unavailable'));
    });
  });

  it('returns null for empty ANN labels and preserves Float32Array input', async () => {
    await withTempDir(async (dir) => {
      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache(makeConfig(dir));
      cache.vectorStore = [{ vector: [1, 2, 3] }];
      const searchKnn = vi.fn().mockReturnValue({});
      cache.annIndex = { searchKnn };
      cache.annDirty = false;

      const query = Float32Array.from([0.1, 0.2]);
      const result = await cache.queryAnn(query, 2);

      expect(result).toBeNull();
      expect(searchKnn).toHaveBeenCalledWith(query, 2);
    });
  });

  it('logs embedding model and size mismatches when loading ANN metadata', async () => {
    await withTempDir(async (dir) => {
      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache(makeConfig(dir));
      cache.vectorStore = [{ vector: [1, 2, 3] }];

      const annMetaFile = path.join(dir, 'ann-meta.json');

      await fs.writeFile(
        annMetaFile,
        JSON.stringify({
          version: 1,
          embeddingModel: 'other-model',
          dim: 3,
          count: 1,
          metric: 'cosine',
          m: 48,
          efConstruction: 200,
        })
      );
      await cache.loadAnnIndexFromDisk(class {}, 3);

      await fs.writeFile(
        annMetaFile,
        JSON.stringify({
          version: 1,
          embeddingModel: 'test-model',
          dim: 2,
          count: 5,
          metric: 'cosine',
          m: 48,
          efConstruction: 200,
        })
      );
      await cache.loadAnnIndexFromDisk(class {}, 3);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Embedding model changed for ANN index')
      );
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('ANN index size mismatch'));
    });
  });
});
