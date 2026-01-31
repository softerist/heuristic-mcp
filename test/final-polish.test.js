import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodebaseIndexer, handleToolCall } from '../features/index-codebase.js';
import { EmbeddingsCache } from '../lib/cache.js';
import fs from 'fs/promises';

// Mock dependencies
vi.mock('fs/promises');
vi.mock('../lib/call-graph.js', () => ({
  extractCallData: vi.fn().mockReturnValue({}),
}));
vi.mock('../lib/utils.js', async () => {
  const actual = await vi.importActual('../lib/utils.js');
  return {
    ...actual,
    hashContent: vi.fn().mockReturnValue('fixed-hash'),
    smartChunk: actual.smartChunk,
  };
});
vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('events');
  class Worker extends EventEmitter {
    constructor() {
      super();
      setTimeout(() => this.emit('message', { type: 'ready' }), 1);
    }
    terminate() {
      return Promise.resolve();
    }
    postMessage(msg) {
      if (msg.type === 'process') {
        this.emit('message', { type: 'results', results: [], batchId: msg.batchId });
      }
    }
  }
  return { Worker };
});

vi.mock('os', async () => {
  return {
    default: { cpus: () => [{}, {}, {}, {}] },
    cpus: () => [{}, {}, {}, {}],
  };
});

describe('Final Polish Coverage', () => {
  let indexer;
  let config;
  let cache;
  let embedder;

  beforeEach(() => {
    config = {
      workerThreads: 2,
      verbose: true,
      embeddingModel: 'test-model',
      searchDirectory: '/test',
      maxFileSize: 100,
      fileExtensions: ['js'],
      excludePatterns: [],
      callGraphEnabled: true,
    };

    cache = {
      save: vi.fn(),
      getVectorStore: vi.fn().mockReturnValue([]),
      setVectorStore: vi.fn(),
      fileHashes: new Map(),
      fileCallData: new Map(),
      getFileHash: vi.fn(),
      setFileHash: vi.fn(),
      removeFileFromStore: vi.fn(),
      addToStore: vi.fn(),
      setFileCallData: vi.fn(),
      clearCallGraphData: vi.fn(),
      pruneCallGraphData: vi.fn(),
      rebuildCallGraph: vi.fn(),
      ensureAnnIndex: vi.fn().mockResolvedValue(),
      deleteFileHash: vi.fn(),
      setLastIndexDuration: vi.fn(),
      setLastIndexStats: vi.fn(),
      setFileHashes: vi.fn((map) => { cache.fileHashes = map; }),
      getFileHashKeys: vi.fn().mockImplementation(() => [...cache.fileHashes.keys()]),
      getFileCallDataKeys: vi.fn().mockImplementation(() => [...cache.fileCallData.keys()]),
      setFileCallDataEntries: vi.fn((map) => { cache.fileCallData = map; }),
      clearFileCallData: vi.fn(() => { cache.fileCallData = new Map(); }),
      getFileMeta: vi.fn(),
    };

    embedder = vi.fn().mockResolvedValue({ data: [] });

    indexer = new CodebaseIndexer(embedder, cache, config);
    indexer.discoverFiles = vi.fn().mockResolvedValue(['/test/file1.js']);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('lib/cache.js', () => {
    it('handles invalid JSON in cache metadata (line 123)', async () => {
      // While targeting 673, let's also cover metadata parsing failure if needed
      const config = { enableCache: true, cacheDirectory: '/c' };
      const cache = new EmbeddingsCache(config);
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(fs, 'mkdir').mockResolvedValue();
      // Return invalid JSON for meta
      vi.spyOn(fs, 'readFile').mockImplementation(async (p) => {
        if (p.endsWith('meta.json')) return '{ invalid';
        return null;
      });

      await cache.load();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid cache metadata'));
    });

    it('handles ANN metadata rebuilding (line 332)', async () => {
      // Just extra coverage for ANN loading
      const config = { enableCache: true, cacheDirectory: '/c', annEnabled: true };
      const cache = new EmbeddingsCache(config);
      cache.vectorStore = [{ vector: [1] }];

      vi.spyOn(fs, 'readFile').mockResolvedValue('invalid-json');

      const loaded = await cache.loadAnnIndexFromDisk({}, 1);
      expect(loaded).toBe(false);
    });
  });

  describe('features/index-codebase.js', () => {
    it('handles stat errors in preFilterFiles (line 483)', async () => {
      // Direct target for 515-516
      vi.spyOn(fs, 'stat').mockRejectedValue(new Error('Stat Fail'));
      const files = ['/test/bad.js'];

      // Directly call the method
      const results = await indexer.preFilterFiles(files);
      expect(results).toEqual([]);
      // We can't easily assert on `skippedCount` local var, but result length 0 implies it filtered.
    });

    it('triggers call-graph data re-indexing (line 578)', async () => {
      // Target 662
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      // 1. All files unchanged initially
      cache.getVectorStore.mockReturnValue([{ file: '/test/file1.js' }]);
      cache.clearFileCallData(); // Empty!
      cache.setFileHashes(new Map([['/test/file1.js', 'fixed-hash']]));
      cache.getFileHash.mockReturnValue('fixed-hash');
      cache.getFileMeta.mockReturnValue({ mtimeMs: 123, size: 50 });

      // Mock fs to pass pre-check and processing
      vi.spyOn(fs, 'stat').mockResolvedValue({ isDirectory: () => false, size: 50, mtimeMs: 123 });
      vi.spyOn(fs, 'readFile').mockResolvedValue('content');

      await indexer.indexAll(false);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('missing call graph data'));
      expect(cache.setFileCallData).toHaveBeenCalled();
    });

    it('returns 0 on indexFile error (line 343)', async () => {
      vi.spyOn(fs, 'stat').mockRejectedValue(new Error('Stat Fail'));
      const result = await indexer.indexFile('/test/bad.js');
      expect(result).toBe(0);
    });

    it('reports processed files in tool response (line 992)', async () => {
      // Mock indexAll result
      indexer.indexAll = vi.fn().mockResolvedValue({
        filesProcessed: 5,
        chunksCreated: 10,
        totalFiles: 5,
        totalChunks: 10,
      });

      const request = { params: { arguments: { force: true } } };
      const result = await handleToolCall(request, indexer);

      expect(result.content[0].text).toContain('Files processed this run: 5');
    });
  });
});

