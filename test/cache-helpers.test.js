import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingsCache } from '../lib/cache.js';
import fs from 'fs/promises';

vi.mock('fs/promises');

// Basic mock index for stats
const mockIndex = {
  setEf: vi.fn(),
  efConstruction: 200,
  m: 48,
  getK: vi.fn(),
};

describe('EmbeddingsCache Helper Methods', () => {
  let cache;
  let config;

  beforeEach(() => {
    vi.clearAllMocks();
    config = {
      enableCache: true,
      cacheDirectory: '/mock/cache',
      annEnabled: true,
      annEfSearch: 10,

      callGraphEnabled: true,
      callGraphMaxHops: 2,
      verbose: true,
    };
    cache = new EmbeddingsCache(config);

    // Spy on console
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('EF Search Configuration', () => {
    it('should validate efSearch input', () => {
      expect(cache.setEfSearch('invalid').success).toBe(false);
      expect(cache.setEfSearch(0).success).toBe(false);
      expect(cache.setEfSearch(1001).success).toBe(false);
    });

    it('should update config when index not loaded', () => {
      const result = cache.setEfSearch(100);
      expect(result.success).toBe(true);
      expect(result.applied).toBe(false);
      expect(cache.config.annEfSearch).toBe(100);
    });

    it('should update active index if loaded', () => {
      cache.annIndex = mockIndex;
      const result = cache.setEfSearch(50);
      expect(result.success).toBe(true);
      expect(result.applied).toBe(true);
      expect(mockIndex.setEf).toHaveBeenCalledWith(50);
    });
  });

  describe('ANN Stats', () => {
    it('should return stats with no index', () => {
      const stats = cache.getAnnStats();
      expect(stats.indexLoaded).toBe(false);
      expect(stats.enabled).toBe(true);
    });

    it('should return stats with index meta', () => {
      cache.annMeta = {
        metric: 'cosine',
        dim: 128,
        count: 10,
        m: 16,
        efConstruction: 100,
      };
      cache.annIndex = {};
      const stats = cache.getAnnStats();
      expect(stats.indexLoaded).toBe(true);
      expect(stats.config.metric).toBe('cosine');
    });
  });

  describe('Vector Store Helpers', () => {
    it('normalizes vectors when setting the store', () => {
      const store = [{ file: 'a.js', vector: [1, 2, 3] }];
      cache.setVectorStore(store);

      const [chunk] = cache.getVectorStore();
      expect(chunk.vector).toBeInstanceOf(Float32Array);
    });
  });

  describe('Call Graph Helper Methods', () => {
    it('should manage file call data', () => {
      const file = 'test.js';
      const data = { valid: true };

      cache.setFileCallData(file, data);
      expect(cache.getFileCallData(file)).toBe(data);
      expect(cache.callGraph).toBeNull(); // invalidation

      cache.removeFileCallData(file);
      expect(cache.getFileCallData(file)).toBeUndefined();
    });

    it('should clear call graph data and file', async () => {
      cache.setFileCallData('a.js', {});
      await cache.clearCallGraphData({ removeFile: true });

      expect(cache.getFileCallDataCount()).toBe(0);
      expect(fs.rm).toHaveBeenCalledWith(
        expect.stringContaining('call-graph.json'),
        expect.any(Object)
      );
    });

    it('should handle pruning', () => {
      cache.setFileCallData('a.js', {});
      cache.setFileCallData('b.js', {});

      const validFiles = new Set(['a.js']);
      const pruned = cache.pruneCallGraphData(validFiles);

      expect(pruned).toBe(1);
      expect(cache.getFileCallData('b.js')).toBeUndefined();
      expect(cache.getFileCallData('a.js')).toBeDefined();
    });

    it('should handle pruning with no valid files set (guard)', () => {
      expect(cache.pruneCallGraphData(null)).toBe(0);
    });
  });

  describe('Call Graph Lazy Loading', () => {
    beforeEach(() => {
      vi.resetModules();
      // We need to re-import CodebaseIndexer or Cache if we were testing its internal dynamic imports,
      // but we are testing cache.js which does dynamic imports of call-graph.js.
      // We mock call-graph.js
      const fakeGraph = { defines: new Map(), calledBy: new Map() };
      vi.doMock('../lib/call-graph.js', () => ({
        buildCallGraph: vi.fn(() => fakeGraph),
        getRelatedFiles: vi.fn(() => new Map([['related.js', 1]])),
      }));
    });

    it('rebuildCallGraph should handle import and build', async () => {
      // Re-instantiate to ensure clean state
      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache({ ...config, verbose: true });

      cache.setFileCallData('f.js', {});

      // Spy on console to verify success
      const logSpy = vi.spyOn(console, 'info');

      // Trigger rebuild
      await cache.rebuildCallGraph();

      // Wait for microtask resolution of dynamic import
      await new Promise((r) => setTimeout(r, 10));

      expect(cache.callGraph).toBeDefined();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Built graph'));
    });

    it('rebuildCallGraph should handle errors', async () => {
      vi.doMock('../lib/call-graph.js', () => ({
        buildCallGraph: vi.fn(() => {
          throw new Error('Build failed');
        }),
      }));

      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache({ ...config, verbose: true });

      const logSpy = vi.spyOn(console, 'error');
      cache.rebuildCallGraph();

      await new Promise((r) => setTimeout(r, 10));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to build'));
    });

    it('getRelatedFiles should rebuild graph if missing', async () => {
      const { EmbeddingsCache } = await import('../lib/cache.js');
      const cache = new EmbeddingsCache(config);
      cache.setFileCallData('f.js', {});

      const result = await cache.getRelatedFiles(['sym']);

      expect(result.size).toBe(1); // Mock returns 1 item
      expect(cache.callGraph).toBeDefined();
    });

    it('getRelatedFiles should return empty if disabled or empty', async () => {
      const { EmbeddingsCache } = await import('../lib/cache.js');
      // Disabled
      let c = new EmbeddingsCache({ ...config, callGraphEnabled: false });
      expect((await c.getRelatedFiles(['s'])).size).toBe(0);

      // Empty symbols
      c = new EmbeddingsCache(config);
      expect((await c.getRelatedFiles([])).size).toBe(0);
    });
  });
});
