import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heuristic-cache-extra-'));
  try {
    await testFn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('EmbeddingsCache additional coverage', () => {
  let warnSpy;
  let infoSpy;
  let errorSpy;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('logs missing metadata, version mismatch, model mismatch, and call-graph loads', async () => {
    await withTempDir(async (dir) => {
      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache(makeConfig(dir));

      await fs.writeFile(path.join(dir, 'embeddings.json'), JSON.stringify([]));
      await fs.writeFile(path.join(dir, 'file-hashes.json'), JSON.stringify({}));

      await cache.load();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Missing cache metadata'));

      await fs.writeFile(
        path.join(dir, 'meta.json'),
        JSON.stringify({ version: 999, embeddingModel: 'test-model' })
      );
      await cache.load();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Cache version mismatch'));

      await fs.writeFile(
        path.join(dir, 'meta.json'),
        JSON.stringify({ version: 1, embeddingModel: 'other-model' })
      );
      await cache.load();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Embedding model changed'));

      await fs.writeFile(
        path.join(dir, 'meta.json'),
        JSON.stringify({ version: 1, embeddingModel: 'test-model' })
      );
      await fs.writeFile(path.join(dir, 'call-graph.json'), JSON.stringify({ 'a.js': {} }));
      await cache.load();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Loaded call-graph data'));
    });
  });

  it('normalizes labels via Array.from and filters invalid ANN results', async () => {
    await withTempDir(async (dir) => {
      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache(makeConfig(dir));
      cache.vectorStore = [{ vector: [1, 2, 3] }];
      const searchKnn = vi.fn().mockReturnValue({ labels: new Set([-1, 0, 5]) });
      cache.annIndex = { searchKnn };
      cache.annDirty = false;

      const result = await cache.queryAnn([1, 2, 3], 3);

      expect(result).toEqual([0]);
    });
  });

  it('deletes file hashes and returns null for missing vectors', async () => {
    await withTempDir(async (dir) => {
      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache(makeConfig(dir));

      cache.setFileHash('a.js', 'hash');
      cache.deleteFileHash('a.js');
      expect(cache.getFileHash('a.js')).toBeUndefined();

      cache.vectorStore = [{}];
      expect(cache.getAnnVector(0)).toBeNull();
    });
  });

  it('handles invalid ANN metadata and config mismatch', async () => {
    await withTempDir(async (dir) => {
      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache(makeConfig(dir));
      cache.vectorStore = [{ vector: [1, 2, 3] }];

      const metaFile = path.join(dir, 'ann-meta.json');
      await fs.writeFile(metaFile, 'not-json');
      await cache.loadAnnIndexFromDisk(class {}, 3);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid ANN metadata'));

      await fs.writeFile(
        metaFile,
        JSON.stringify({
          version: 1,
          embeddingModel: 'test-model',
          dim: 3,
          count: 1,
          metric: 'l2',
          m: 48,
          efConstruction: 200,
        })
      );
      await cache.loadAnnIndexFromDisk(class {}, 3);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ANN index config changed'));
    });
  });

  it('throws when building ANN index encounters missing vectors', async () => {
    await withTempDir(async (dir) => {
      vi.doMock('hnswlib-node', () => ({
        HierarchicalNSW: class {
          initIndex() {}
          addPoint() {}
        },
      }));
      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache(makeConfig(dir, { annIndexCache: false }));
      cache.vectorStore = [{ vector: [1, 2] }, { vector: null }];

      const result = await cache.ensureAnnIndex();

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to build ANN index'));
    });
  });

  it('reports call graph stats', async () => {
    await withTempDir(async (dir) => {
      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache(makeConfig(dir));

      const stats = cache.getCallGraphStats();

      expect(stats.enabled).toBe(true);
    });
  });

  it('logs hnswlib missing export errors', async () => {
    await withTempDir(async (dir) => {
      vi.doMock('hnswlib-node', () => ({
        default: { HierarchicalNSW: null },
        HierarchicalNSW: null,
      }));
      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache(makeConfig(dir));
      cache.vectorStore = [{ vector: [1, 2, 3] }];

      const result = await cache.ensureAnnIndex();

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('HierarchicalNSW export not found')
      );
    });
  });

  it('short-circuits load/save/clear when cache is disabled', async () => {
    await withTempDir(async (dir) => {
      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache(makeConfig(dir, { enableCache: false }));
      const rmSpy = vi.spyOn(fs, 'rm').mockResolvedValue();

      await cache.load();
      await cache.save();
      await cache.clear();

      expect(rmSpy).not.toHaveBeenCalled();
      rmSpy.mockRestore();
    });
  });

  it('normalizes empty and array ANN label results', async () => {
    await withTempDir(async (dir) => {
      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache(makeConfig(dir));
      cache.vectorStore = [{ vector: [1, 2, 3] }];
      cache.annDirty = false;

      cache.annIndex = { searchKnn: vi.fn().mockReturnValue(null) };
      const emptyResult = await cache.queryAnn([1, 2, 3], 1);
      expect(emptyResult).toEqual([]);

      cache.annIndex = { searchKnn: vi.fn().mockReturnValue([0]) };
      const arrayResult = await cache.queryAnn([1, 2, 3], 1);
      expect(arrayResult).toEqual([0]);
    });
  });

  it('returns existing annLoading promises and handles missing dims', async () => {
    await withTempDir(async (dir) => {
      vi.doMock('hnswlib-node', () => ({
        HierarchicalNSW: class {},
        default: { HierarchicalNSW: class {} },
      }));
      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache(makeConfig(dir));
      cache.vectorStore = [{}];

      const loading = Promise.resolve('loading');
      cache.annLoading = loading;

      const result = await cache.ensureAnnIndex();
      expect(result).toBe('loading');

      cache.annLoading = null;
      const dimResult = await cache.ensureAnnIndex();
      expect(dimResult).toBeNull();
    });
  });

  it('handles missing ANN metadata and empty ANN builds', async () => {
    await withTempDir(async (dir) => {
      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache(makeConfig(dir));

      const loaded = await cache.loadAnnIndexFromDisk(class {}, 3);
      expect(loaded).toBe(false);

      cache.vectorStore = [];
      const built = await cache.buildAnnIndex(class {}, 3);
      expect(built).toBeNull();
    });
  });

  it('uses default error message when JSON worker fails without error details (line 38)', async () => {
    const { EventEmitter } = await import('events');
    const Worker = vi.fn(function () {
      const worker = new EventEmitter();
      setImmediate(() => {
        worker.emit('message', { ok: false });
      });
      return worker;
    });

    const fsMock = {
      stat: vi.fn().mockResolvedValue({ size: 10 * 1024 * 1024 }),
      readFile: vi.fn().mockResolvedValue(JSON.stringify({ version: 1, embeddingModel: 'test-model' })),
      mkdir: vi.fn().mockResolvedValue(undefined),
    };

    vi.doMock('worker_threads', () => ({ Worker }));
    vi.doMock('fs/promises', () => ({ default: fsMock, ...fsMock }));

    const { EmbeddingsCache } = await import('../lib/cache.js');
    const cache = new EmbeddingsCache(makeConfig('/tmp'));
    
    await cache.load();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('JSON worker failed'));
  });

  it('handles non-array store in setVectorStore (line 320)', async () => {
    const { EmbeddingsCache } = await import('../lib/cache.js');
    const cache = new EmbeddingsCache(makeConfig('/tmp'));
    
    cache.setVectorStore(null);
    expect(cache.vectorStore).toBeNull();
    
    cache.setVectorStore({ not: 'an array' });
    expect(cache.vectorStore).toEqual({ not: 'an array' });
  });
});
