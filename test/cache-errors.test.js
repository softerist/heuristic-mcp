import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';

// Mock fs
vi.mock('fs/promises');
vi.mock('../lib/json-writer.js', () => ({
  StreamingJsonWriter: class {
    writeStart() {
      return Promise.resolve();
    }
    writeItem() {}
    writeEnd() {
      return Promise.resolve();
    }
  },
}));

// Define mocks at top level to ensure stability across module resets
const mockIndex = {
  initIndex: vi.fn(),
  readIndexSync: vi.fn(),
  writeIndexSync: vi.fn(),
  addPoint: vi.fn(),
  setEf: vi.fn(),
  searchKnn: vi.fn().mockReturnValue({ distances: [], neighbors: [] }),
  getMaxElements: vi.fn().mockReturnValue(100),
  getCurrentCount: vi.fn().mockReturnValue(0),
};

// Use a regular function for constructor
const mockConstructor = vi.fn(function () {
  return mockIndex;
});

// Mock hnswlib-node with stable constructor
vi.mock('hnswlib-node', () => {
  return {
    default: {
      HierarchicalNSW: mockConstructor,
    },
    HierarchicalNSW: mockConstructor,
  };
});

describe('EmbeddingsCache Error Handling', () => {
  let cache;
  let config;

  beforeEach(async () => {
    vi.clearAllMocks(); // Clear call history
    vi.resetModules(); // Reset module cache

    // Reset default implementations for consistency
    mockIndex.initIndex.mockImplementation(() => undefined);
    mockIndex.readIndexSync.mockImplementation(() => true);
    mockIndex.addPoint.mockImplementation(() => undefined);
    mockIndex.writeIndexSync.mockImplementation(() => undefined);

    // Dynamic import to pick up fresh mock and reset module state
    const { EmbeddingsCache } = await import('../lib/cache.js');

    config = {
      enableCache: true,
      cacheDirectory: '/mock/cache',
      fileExtensions: ['js'],
      embeddingModel: 'test-model',
      annEnabled: true,
      annMinChunks: 1,
      annMetric: 'cosine',
      annM: 48,
      annEfConstruction: 200,
      annEfSearch: 10,
      verbose: true,
    };
    cache = new EmbeddingsCache(config);

    // Spy on console warn/error but verify calls
    vi.spyOn(console, 'warn');
    vi.spyOn(console, 'error');

    fs.readFile.mockResolvedValue(null);
    fs.writeFile.mockResolvedValue();
    fs.mkdir.mockResolvedValue();
    fs.rm.mockResolvedValue();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('HNSW Initialization Retries', () => {
    it('should retry initIndex with different parameters on failure', async () => {
      mockIndex.initIndex
        .mockImplementationOnce(() => {
          throw new Error('Fail 1');
        })
        .mockImplementationOnce(() => {
          throw new Error('Fail 2');
        })
        .mockImplementationOnce(() => Promise.resolve());

      cache.vectorStore = [{ vector: [1] }];
      await cache.ensureAnnIndex();

      expect(mockIndex.initIndex).toHaveBeenCalledTimes(3);
    });

    it('should fallback to linear search if all initIndex attempts fail', async () => {
      mockIndex.initIndex.mockImplementation(() => {
        throw new Error('Fail Always');
      });

      cache.vectorStore = [{ vector: [1] }];
      const index = await cache.ensureAnnIndex();

      expect(index).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to build ANN index')
      );
    });
  });

  describe('HNSW Read Retries', () => {
    it('should retry readIndexSync on failure', async () => {
      fs.readFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          embeddingModel: 'test-model',
          dim: 1,
          count: 1,
          metric: 'cosine',
          m: 48,
          efConstruction: 200,
        })
      );

      mockIndex.readIndexSync
        .mockImplementationOnce(() => {
          throw new Error('Fail 1');
        })
        .mockReturnValue(true);

      cache.vectorStore = [{ vector: [1] }];
      const index = await cache.ensureAnnIndex();

      expect(index).toBeDefined();
      expect(mockIndex.readIndexSync).toHaveBeenCalledTimes(2);
    });

    it('should rebuild index if readIndexSync fails completely', async () => {
      fs.readFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          embeddingModel: 'test-model',
          dim: 1,
          count: 1,
          metric: 'cosine',
          m: 48,
          efConstruction: 200,
        })
      );

      mockIndex.readIndexSync.mockImplementation(() => {
        throw new Error('Read Fail');
      });

      cache.vectorStore = [{ vector: [1] }];

      const index = await cache.ensureAnnIndex();

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load ANN index')
      );
      expect(index).toBeDefined();
      expect(mockIndex.initIndex).toHaveBeenCalled();
    });
  });

  describe('File System Errors', () => {
    it('should handle fs errors during load', async () => {
      fs.mkdir.mockRejectedValue(new Error('Permission denied'));
      await cache.load();
      expect(console.warn).toHaveBeenCalledWith(
        '[Cache] Failed to load cache:',
        'Permission denied'
      );
    });

    it('should handle fs errors during save', async () => {
      cache.vectorStore = [{ vector: [1] }];
      fs.mkdir.mockRejectedValue(new Error('Read-only file system'));
      await cache.save();
      expect(console.warn).toHaveBeenCalledWith(
        '[Cache] Failed to save cache:',
        'Read-only file system'
      );
      expect(cache.isSaving).toBe(false);
    });

    it('should handle clear cache errors', async () => {
      fs.rm.mockRejectedValue(new Error('Locked'));
      await expect(cache.clear()).rejects.toThrow('Locked');
      expect(console.error).toHaveBeenCalledWith('[Cache] Failed to clear cache:', 'Locked');
    });

    it('should handle call graph save errors', async () => {
      fs.mkdir.mockResolvedValue();
      fs.writeFile.mockImplementation((path) => {
        if (path.includes('call-graph')) return Promise.reject(new Error('Graph Write Fail'));
        return Promise.resolve();
      });

      cache.setFileCallData('f.js', {});
      await cache.save();
      expect(console.warn).toHaveBeenCalledWith(
        '[Cache] Failed to save cache:',
        'Graph Write Fail'
      );
    });
  });

  describe('ANN Rebuild Edge Cases', () => {
    it('should handle metadata mismatch forcing rebuild', async () => {
      fs.readFile.mockResolvedValue(
        JSON.stringify({
          version: 999, // Mismatch
          embeddingModel: 'test-model',
        })
      );

      cache.vectorStore = [{ vector: [1] }];
      const index = await cache.ensureAnnIndex();

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('version mismatch'));
      expect(mockIndex.initIndex).toHaveBeenCalled();
    });

    it('should handle addPoint failure during build', async () => {
      mockIndex.addPoint.mockImplementation(() => {
        throw new Error('Add Fail');
      });

      cache.vectorStore = [{ vector: [1] }];

      const index = await cache.ensureAnnIndex();

      expect(index).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to build ANN index')
      );
    });

    it('should handle save ANN index failure', async () => {
      mockIndex.writeIndexSync.mockImplementation(() => {
        throw new Error('Write Fail');
      });

      cache.vectorStore = [{ vector: [1] }];

      const index = await cache.ensureAnnIndex();

      expect(index).toBeDefined();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save ANN index')
      );
    });
  });
});
