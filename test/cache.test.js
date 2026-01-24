import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { EmbeddingsCache } from '../lib/cache.js';
import { loadConfig } from '../lib/config.js';

let lastHnswInstance = null;
class FakeHnsw {
  constructor(metric, dim) {
    this.metric = metric;
    this.dim = dim;
    lastHnswInstance = this;
  }
  initIndex() {}
  addPoint() {}
  writeIndexSync() {}
  readIndexSync() {}
  setEf(value) {
    this.ef = value;
  }
  searchKnn() {
    return { labels: [0] };
  }
}

vi.mock('hnswlib-node', () => ({
  HierarchicalNSW: FakeHnsw,
}));

async function withTempDir(testFn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heuristic-cache-'));
  try {
    await testFn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function createConfig(cacheDir) {
  const config = await loadConfig();
  config.cacheDirectory = cacheDir;
  config.searchDirectory = cacheDir;
  config.enableCache = true;
  config.callGraphEnabled = true;
  config.embeddingModel = 'test-model';
  config.fileExtensions = ['js'];
  config.excludePatterns = [];
  config.annEnabled = true;
  config.annMinChunks = 1;
  return config;
}

describe('EmbeddingsCache', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should cover all lines', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      const cache = new EmbeddingsCache(config);

      // Line 176
      const mkdirSpy = vi
        .spyOn(fs, 'mkdir')
        .mockRejectedValue(new Error('Failed to create directory'));
      await cache.load();
      expect(console.warn).toHaveBeenCalledWith(
        '[Cache] Failed to load cache:',
        'Failed to create directory'
      );
      mkdirSpy.mockRestore();

      // Line 219
      await cache.save();
      expect(cache.isSaving).toBe(false);

      // Line 246
      cache.setFileCallData('a.js', { defs: [], calls: [] });
      cache.removeFileFromStore('a.js');
      expect(cache.getFileCallData('a.js')).toBeUndefined();
    });
  });

  it('loads cache data and filters extensions', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      config.fileExtensions = ['js'];
      const cache = new EmbeddingsCache(config);

      const meta = { version: 1, embeddingModel: config.embeddingModel };
      const cacheData = [
        { file: path.join(dir, 'a.js'), vector: [1, 2] },
        { file: path.join(dir, 'a.txt'), vector: [3, 4] },
      ];
      const hashData = {
        [path.join(dir, 'a.js')]: 'hash1',
        [path.join(dir, 'a.txt')]: 'hash2',
      };

      await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
      await fs.writeFile(path.join(dir, 'embeddings.json'), JSON.stringify(cacheData));
      await fs.writeFile(path.join(dir, 'file-hashes.json'), JSON.stringify(hashData));

      await cache.load();

      expect(cache.getVectorStore()).toHaveLength(1);
      expect(cache.getFileHash(path.join(dir, 'a.js'))).toBe('hash1');
      expect(cache.getFileHash(path.join(dir, 'a.txt'))).toBeUndefined();
    });
  });

  it('reuses cached ANN vectors', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      const cache = new EmbeddingsCache(config);

      cache.vectorStore = [{ file: 'a.js', vector: [1, 2, 3] }];
      const first = cache.getAnnVector(0);
      const second = cache.getAnnVector(0);

      expect(first).toBeInstanceOf(Float32Array);
      expect(second).toBe(first);
    });
  });

  it('loads ANN index from disk and applies efSearch', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      config.annEfSearch = 32;
      const cache = new EmbeddingsCache(config);
      cache.vectorStore = [{ file: 'a.js', vector: [1, 2] }];

      const meta = {
        version: 1,
        embeddingModel: config.embeddingModel,
        metric: config.annMetric,
        dim: 2,
        count: 1,
        m: config.annM,
        efConstruction: config.annEfConstruction,
      };
      await fs.writeFile(path.join(dir, 'ann-meta.json'), JSON.stringify(meta));
      await fs.writeFile(path.join(dir, 'ann-index.bin'), '');

      const loaded = await cache.loadAnnIndexFromDisk(FakeHnsw, 2);

      expect(loaded).toBe(true);
      expect(cache.annIndex).toBeTruthy();
      expect(lastHnswInstance.ef).toBe(32);
    });
  });

  it('builds ANN index and saves when cache is enabled', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      config.annIndexCache = true;
      const cache = new EmbeddingsCache(config);
      cache.vectorStore = [{ file: 'a.js', vector: [1, 2] }];

      const index = await cache.buildAnnIndex(FakeHnsw, 2);

      expect(index).toBeTruthy();
      expect(cache.annDirty).toBe(false);
      const metaFile = path.join(dir, 'ann-meta.json');
      const metaExists = await fs.readFile(metaFile, 'utf-8');
      expect(JSON.parse(metaExists).count).toBe(1);
    });
  });

  it('reuses hnswlib promise across index builds', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      config.annIndexCache = false;
      const cache = new EmbeddingsCache(config);
      cache.vectorStore = [{ file: 'a.js', vector: [1, 2] }];

      const first = await cache.ensureAnnIndex();
      expect(first).toBeTruthy();

      cache.annIndex = null;
      cache.annDirty = true;
      const second = await cache.ensureAnnIndex();
      expect(second).toBeTruthy();
    });
  });

  it('returns null when ANN labels are invalid', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      const cache = new EmbeddingsCache(config);
      cache.vectorStore = [{ file: 'a.js', vector: [1, 2] }];

      const mockIndex = {
        searchKnn: () => ({ labels: [-1, 10] }),
      };
      vi.spyOn(cache, 'ensureAnnIndex').mockResolvedValue(mockIndex);

      const result = await cache.queryAnn([1, 2], 2);
      expect(result).toBeNull();
    });
  });

  it('uses default values in ANN and call-graph stats', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      delete config.annEnabled;
      delete config.callGraphEnabled;
      const cache = new EmbeddingsCache(config);

      const annStats = cache.getAnnStats();
      const callStats = cache.getCallGraphStats();

      expect(annStats.enabled).toBe(false);
      expect(callStats.enabled).toBe(false);
    });
  });

  it('logs when call-graph cache removal fails', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      config.verbose = true;
      const cache = new EmbeddingsCache(config);
      const rmSpy = vi.spyOn(fs, 'rm').mockRejectedValue(new Error('rm failed'));

      await cache.clearCallGraphData({ removeFile: true });

      const called = console.warn.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('Failed to remove call-graph cache')
      );
      expect(called).toBe(true);
      rmSpy.mockRestore();
    });
  });

  it('handles missing cacheData or hashData in load', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      const cache = new EmbeddingsCache(config);
      const meta = { version: 1, embeddingModel: config.embeddingModel };
      await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
      // embeddings.json and file-hashes.json are missing
      await cache.load();
      expect(cache.getVectorStore()).toEqual([]);
    });
  });

  it('handles index without setEf', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      const cache = new EmbeddingsCache(config);
      cache.vectorStore = [{ file: 'a.js', vector: [1, 2] }];

      class NoEfIndex {
        constructor() {}
        initIndex() {}
        addPoint() {}
        readIndexSync() {
          return true;
        }
        writeIndexSync() {}
      }

      const meta = {
        version: 1,
        embeddingModel: config.embeddingModel,
        metric: config.annMetric,
        dim: 2,
        count: 1,
        m: config.annM,
        efConstruction: config.annEfConstruction,
      };
      await fs.writeFile(path.join(dir, 'ann-meta.json'), JSON.stringify(meta));
      await fs.writeFile(path.join(dir, 'ann-index.bin'), '');

      await cache.loadAnnIndexFromDisk(NoEfIndex, 2);
      expect(cache.annIndex).toBeInstanceOf(NoEfIndex);

      cache.annIndex = null;
      cache.annDirty = true;
      await cache.buildAnnIndex(NoEfIndex, 2);
      expect(cache.annIndex).toBeInstanceOf(NoEfIndex);
    });
  });

  it('handles verbose false in clearCallGraphData failure', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      config.verbose = false;
      const cache = new EmbeddingsCache(config);
      const rmSpy = vi.spyOn(fs, 'rm').mockRejectedValue(new Error('rm failed'));

      await cache.clearCallGraphData({ removeFile: true });

      expect(console.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Failed to remove call-graph cache')
      );
      rmSpy.mockRestore();
    });
  });
});
