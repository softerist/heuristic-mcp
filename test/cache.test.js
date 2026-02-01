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
  let testError;
  try {
    await testFn(dir);
  } catch (error) {
    testError = error;
  }
  {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error?.code !== 'EBUSY' && error?.code !== 'EPERM') {
          testError = testError || error;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  if (testError) {
    throw testError;
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

      await cache.close();
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

      await cache.close();
    });
  });

  it('persists file hash metadata and reloads', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      const cache = new EmbeddingsCache(config);
      const filePath = path.join(dir, 'a.js');

      cache.setFileHash(filePath, 'hash-meta', { mtimeMs: 1234, size: 4567 });
      await cache.save();

      const hashFile = path.join(dir, 'file-hashes.json');
      const raw = JSON.parse(await fs.readFile(hashFile, 'utf-8'));
      expect(raw[filePath]).toEqual({ hash: 'hash-meta', mtimeMs: 1234, size: 4567 });

      const reloaded = new EmbeddingsCache(config);
      await reloaded.load();
      expect(reloaded.getFileHash(filePath)).toBe('hash-meta');
      expect(reloaded.getFileMeta(filePath)).toEqual(
        expect.objectContaining({ hash: 'hash-meta', mtimeMs: 1234, size: 4567 })
      );

      await reloaded.close();
      await cache.close();
    });
  });

  it('writes and loads binary vector store with content lookup', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      config.vectorStoreFormat = 'binary';
      config.vectorStoreContentMode = 'external';
      config.contentCacheEntries = 2;
      const cache = new EmbeddingsCache(config);
      const filePath = path.join(dir, 'b.js');

      cache.vectorStore = [
        {
          file: filePath,
          startLine: 1,
          endLine: 2,
          content: 'console.log("hi")',
          vector: new Float32Array([0.1, 0.2]),
        },
      ];
      cache.setFileHash(filePath, 'hash-binary', { mtimeMs: 10, size: 20 });

      await cache.save();

      const reloaded = new EmbeddingsCache(config);
      await reloaded.load();

      const store = reloaded.getVectorStore();
      expect(store.length).toBe(1);
      await expect(reloaded.getChunkContent(store[0])).resolves.toBe('console.log("hi")');
      expect(reloaded.getChunkVector(store[0])).toBeInstanceOf(Float32Array);

      await reloaded.close();
      await cache.close();
    });
  });

  it('loads binary vector store in disk mode without inline vectors', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      config.vectorStoreFormat = 'binary';
      config.vectorStoreContentMode = 'external';
      config.vectorStoreLoadMode = 'disk';
      config.vectorCacheEntries = 1;
      const cache = new EmbeddingsCache(config);
      const filePath = path.join(dir, 'disk.js');

      cache.vectorStore = [
        {
          file: filePath,
          startLine: 1,
          endLine: 2,
          content: 'console.log("disk")',
          vector: new Float32Array([0.3, 0.6]),
        },
      ];
      cache.setFileHash(filePath, 'hash-disk', { mtimeMs: 10, size: 20 });

      await cache.save();

      const reloaded = new EmbeddingsCache(config);
      await reloaded.load();

      const store = reloaded.getVectorStore();
      expect(store.length).toBe(1);
      expect(store[0].vector).toBeUndefined();
      expect(reloaded.getChunkVector(store[0])).toBeInstanceOf(Float32Array);

      await reloaded.close();
      await cache.close();
    });
  });

  it('writes and loads sqlite vector store with content lookup', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      config.vectorStoreFormat = 'sqlite';
      config.vectorStoreContentMode = 'external';
      config.vectorStoreLoadMode = 'disk';
      const cache = new EmbeddingsCache(config);
      const filePath = path.join(dir, 'sqlite.js');

      cache.vectorStore = [
        {
          file: filePath,
          startLine: 1,
          endLine: 2,
          content: 'console.log("sqlite")',
          vector: new Float32Array([0.9, 0.8]),
        },
      ];
      cache.setFileHash(filePath, 'hash-sqlite', { mtimeMs: 10, size: 20 });

      await cache.save();

      const sqlitePath = path.join(dir, 'vectors.sqlite');
      await expect(fs.stat(sqlitePath)).resolves.toBeDefined();

      const reloaded = new EmbeddingsCache(config);
      await reloaded.load();

      const store = reloaded.getVectorStore();
      expect(store.length).toBe(1);
      expect(store[0].vector).toBeUndefined();
      await expect(reloaded.getChunkContent(store[0])).resolves.toBe('console.log("sqlite")');
      expect(reloaded.getChunkVector(store[0])).toBeInstanceOf(Float32Array);

      await reloaded.close();
      await cache.close();
    });
  });

  it('migrates from JSON cache to binary store on save', async () => {
    await withTempDir(async (dir) => {
      const config = await createConfig(dir);
      config.vectorStoreFormat = 'binary';
      config.vectorStoreContentMode = 'external';

      const filePath = path.join(dir, 'migrate.js');
      const meta = { version: 1, embeddingModel: config.embeddingModel };
      const cacheData = [
        {
          file: filePath,
          startLine: 1,
          endLine: 2,
          content: 'export const x = 1;',
          vector: [0.3, 0.4],
        },
      ];
      const hashData = { [filePath]: 'hash-migrate' };

      await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
      await fs.writeFile(path.join(dir, 'embeddings.json'), JSON.stringify(cacheData));
      await fs.writeFile(path.join(dir, 'file-hashes.json'), JSON.stringify(hashData));

      const cache = new EmbeddingsCache(config);
      await cache.load();
      expect(cache.getVectorStore()).toHaveLength(1);

      await cache.save();

      const vectorsPath = path.join(dir, 'vectors.bin');
      const recordsPath = path.join(dir, 'records.bin');
      const contentPath = path.join(dir, 'content.bin');
      const filesPath = path.join(dir, 'files.json');

      await expect(fs.readFile(vectorsPath)).resolves.toBeDefined();
      await expect(fs.readFile(recordsPath)).resolves.toBeDefined();
      await expect(fs.readFile(contentPath)).resolves.toBeDefined();
      await expect(fs.readFile(filesPath)).resolves.toBeDefined();

      await cache.close();
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

      await cache.close();
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

      await cache.close();
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

      await cache.close();
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

      await cache.close();
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
      expect(result).toEqual([]);

      await cache.close();
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

      await cache.close();
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

      await cache.close();
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

      await cache.close();
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

      await cache.close();
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

      await cache.close();
    });
  });
});
