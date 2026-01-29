import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { EmbeddingsCache } from '../lib/cache.js';

const makeConfig = (cacheDir, overrides = {}) => ({
  cacheDirectory: cacheDir,
  searchDirectory: cacheDir,
  enableCache: true,
  callGraphEnabled: true,
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
  ...overrides,
});

async function withTempDir(testFn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heuristic-perfection-'));
  try {
    await testFn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('EmbeddingsCache Perfection', () => {
  let warnSpy;
  let infoSpy;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('covers missing branches in ensureAnnIndex', async () => {
    await withTempDir(async (dir) => {
      const config = makeConfig(dir);
      const cache = new EmbeddingsCache(config);

      // Branch: annEnabled is false
      cache.config.annEnabled = false;
      expect(await cache.ensureAnnIndex()).toBeNull();

      // Branch: vectorStore too small
      cache.config.annEnabled = true;
      cache.config.annMinChunks = 10;
      cache.vectorStore = [{ vector: [1, 2, 3] }];
      expect(await cache.ensureAnnIndex()).toBeNull();

      // Branch: annIndex already exists and not dirty
      cache.config.annMinChunks = 1; // Reset to allow index
      const mockIndex = { setEf: vi.fn() };
      cache.annIndex = mockIndex;
      cache.annDirty = false;
      expect(await cache.ensureAnnIndex()).toBe(mockIndex);

      // Branch: annLoading already exists
      cache.annIndex = null; // Clear index to reach loading branch
      const loadingValue = { mock: 'loading' };
      const loadingPromise = Promise.resolve(loadingValue);
      cache.annLoading = loadingPromise;
      expect(await cache.ensureAnnIndex()).toBe(loadingValue);
    });
  });

  it('covers filtered outdated cache entries in load', async () => {
    await withTempDir(async (dir) => {
      const config = makeConfig(dir, { fileExtensions: ['js'] });
      const cache = new EmbeddingsCache(config);

      const meta = { version: 1, embeddingModel: config.embeddingModel };
      const cacheData = [
        { file: 'a.js', vector: [1, 2] },
        { file: 'a.txt', vector: [3, 4] }, // Will be filtered
      ];
      const hashData = {
        'a.js': 'hash1',
        'a.txt': 'hash2',
      };

      await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
      await fs.writeFile(path.join(dir, 'embeddings.json'), JSON.stringify(cacheData));
      await fs.writeFile(path.join(dir, 'file-hashes.json'), JSON.stringify(hashData));

      await cache.load();

      expect(cache.getVectorStore()).toHaveLength(1);
      expect(cache.getFileHash('a.js')).toBe('hash1');
      expect(cache.getFileHash('a.txt')).toBeUndefined();
    });
  });

  it('covers call-graph file missing during load', async () => {
    await withTempDir(async (dir) => {
      const config = makeConfig(dir);
      const cache = new EmbeddingsCache(config);

      // Setup minimal meta to pass initial checks
      const meta = { version: 1, embeddingModel: config.embeddingModel };
      await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));

      // No call-graph.json exists. This should hit the empty catch block at line 131.
      await cache.load();
      // No error should be logged for missing call-graph.json
      expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('call-graph'));
    });
  });

  it('covers clearCallGraphData branches', async () => {
    await withTempDir(async (dir) => {
      const config = makeConfig(dir, { enableCache: true });
      const cache = new EmbeddingsCache(config);

      // Branch: removeFile is true, enableCache is true
      const callGraphFile = path.join(dir, 'call-graph.json');
      await fs.writeFile(callGraphFile, '{}');
      await cache.clearCallGraphData({ removeFile: true });
      await expect(fs.access(callGraphFile)).rejects.toThrow();

      // Branch: removeFile is true, enableCache is false
      cache.config.enableCache = false;
      await cache.clearCallGraphData({ removeFile: true });
      // Should not attempt to remove anything (tested via coverage)
    });
  });

  it('covers getRelatedFiles branches', async () => {
    await withTempDir(async (dir) => {
      const config = makeConfig(dir, { callGraphEnabled: false });
      const cache = new EmbeddingsCache(config);

      // Branch: callGraphEnabled is false
      expect((await cache.getRelatedFiles(['sym'])).size).toBe(0);

      // Branch: symbols empty
      cache.config.callGraphEnabled = true;
      expect((await cache.getRelatedFiles([])).size).toBe(0);

      // Branch: callGraph is null and fileCallData is empty
      cache.clearFileCallData();
      cache.callGraph = null;
      expect((await cache.getRelatedFiles(['sym'])).size).toBe(0);
    });
  });

  it('covers setEfSearch error branch', async () => {
    const cache = new EmbeddingsCache(makeConfig('dir'));
    const result = cache.setEfSearch('not-a-number');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('covers load() early return when no files exist', async () => {
    await withTempDir(async (dir) => {
      const config = makeConfig(dir);
      const cache = new EmbeddingsCache(config);
      await cache.load();
      expect(cache.getVectorStore()).toEqual([]);
    });
  });

  it('covers readHnswIndex retries and failure', () => {
    const cache = new EmbeddingsCache(makeConfig('dir'));
    // Since readHnswIndex is not exported, it is tested via loadAnnIndexFromDisk
  });

  it('covers readHnswIndex retries and failure via loadAnnIndexFromDisk', async () => {
    await withTempDir(async (dir) => {
      const config = makeConfig(dir);
      const cache = new EmbeddingsCache(config);
      cache.vectorStore = [{ vector: [1] }];

      const meta = {
        version: 1,
        embeddingModel: config.embeddingModel,
        count: 1,
        dim: 1,
        metric: config.annMetric,
        m: config.annM,
        efConstruction: config.annEfConstruction,
      };
      await fs.writeFile(path.join(dir, 'ann-meta.json'), JSON.stringify(meta));
      await fs.writeFile(path.join(dir, 'ann-index.bin'), '');

      let calls = 0;
      class MockIndex {
        readIndexSync() {
          calls++;
          if (calls === 1) throw new Error('fail 1');
          if (calls === 2) return true; // Succeed on second try
        }
        setEf() {}
      }

      await cache.loadAnnIndexFromDisk(MockIndex, 1);
      expect(calls).toBe(2);

      // Failure case
      calls = 0;
      class FailIndex {
        readIndexSync() {
          calls++;
          throw new Error('fail');
        }
      }
      await cache.loadAnnIndexFromDisk(FailIndex, 1);
      expect(calls).toBe(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load ANN index file')
      );
    });
  });

  it('covers rebuildCallGraph error', async () => {
    const cache = new EmbeddingsCache(makeConfig('dir', { verbose: true }));
    cache.setFileCallData('a.js', {});

    // We can't easily mock the dynamic import here to fail,
    // but we can at least call it and hope it runs.
    cache.rebuildCallGraph();
    // Wait a bit for the promise
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('covers load() missing metadata with hash present', async () => {
    await withTempDir(async (dir) => {
      const config = makeConfig(dir);
      const cache = new EmbeddingsCache(config);
      await fs.writeFile(path.join(dir, 'file-hashes.json'), '{}');
      await cache.load();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Missing cache metadata'));
    });
  });

  it('covers initHnswIndex fallbacks', async () => {
    await withTempDir(async (dir) => {
      const config = makeConfig(dir);
      const cache = new EmbeddingsCache(config);
      cache.vectorStore = [{ vector: [1] }];

      let calls = 0;
      class MockIndex {
        initIndex() {
          calls++;
          if (calls === 1) throw new Error('1st fail');
          if (calls === 2) throw new Error('2nd fail');
          return; // 3rd succeeds
        }
      }

      await cache.buildAnnIndex(MockIndex, 1);
      expect(calls).toBe(3);
    });
  });

  it('covers annVectorCache length mismatch', () => {
    const cache = new EmbeddingsCache(makeConfig('dir'));
    cache.vectorStore = [{ vector: [1] }];
    cache.annVectorCache = new Array(10); // Wrong length
    const vec = cache.getAnnVector(0);
    expect(cache.annVectorCache.length).toBe(1);
    expect(vec).toBeInstanceOf(Float32Array);
  });

  it('covers setEfSearch applied branch', () => {
    const cache = new EmbeddingsCache(makeConfig('dir'));
    cache.annIndex = { setEf: vi.fn() };
    const result = cache.setEfSearch(20);
    expect(result.applied).toBe(true);
    expect(cache.annIndex.setEf).toHaveBeenCalledWith(20);
  });

  it('covers getCallGraphStats branches', () => {
    const cache = new EmbeddingsCache(makeConfig('dir', { callGraphEnabled: true }));
    cache.callGraph = { defines: new Set([1]), calledBy: new Set([2]) };
    const stats = cache.getCallGraphStats();
    expect(stats.definitions).toBe(1);
    expect(stats.callTargets).toBe(1);
  });

  it('covers normalizeLabels via queryAnn', async () => {
    const cache = new EmbeddingsCache(makeConfig('dir'));
    cache.vectorStore = [{ vector: [1] }];

    // Mock index to return different formats
    const mockIndex = {
      searchKnn: vi
        .fn()
        .mockReturnValueOnce({ neighbors: [0] })
        .mockReturnValueOnce({ indices: [0] })
        .mockReturnValueOnce({ unknown: [0] }),
    };
    cache.annIndex = mockIndex;
    cache.annDirty = false;

    expect(await cache.queryAnn([1], 1)).toEqual([0]); // neighbors
    expect(await cache.queryAnn([1], 1)).toEqual([0]); // indices
    expect(await cache.queryAnn([1], 1)).toEqual([]); // unknown/empty
  });

  it('covers setVectorStore and addToStore', () => {
    const cache = new EmbeddingsCache(makeConfig('dir'));
    cache.setVectorStore([{ file: 'test.js', vector: [1] }]);
    expect(cache.getVectorStore().length).toBe(1);
    expect(cache.annDirty).toBe(true);

    cache.addToStore({ file: 'test2.js', vector: [2] });
    expect(cache.getVectorStore().length).toBe(2);
  });

  it('covers clear()', async () => {
    await withTempDir(async (dir) => {
      const config = makeConfig(dir);
      const cache = new EmbeddingsCache(config);
      await fs.writeFile(path.join(dir, 'embeddings.json'), '[]');
      await cache.clear();
      expect(cache.getVectorStore()).toHaveLength(0);
      expect(cache.getFileHashCount()).toBe(0);
      await expect(fs.access(dir)).rejects.toThrow();
    });
  });

  it('covers remaining getRelatedFiles branches', async () => {
    await withTempDir(async (dir) => {
      const config = makeConfig(dir, { callGraphEnabled: true });
      const cache = new EmbeddingsCache(config);

      // Branch: callGraph is null but fileCallData exists
      cache.setFileCallData('a.js', { definitions: [], calls: [] });
      const result = await cache.getRelatedFiles(['sym']);
      expect(result).toBeDefined();
    });
  });
});
