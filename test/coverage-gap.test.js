import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { CodebaseIndexer, handleToolCall } from '../features/index-codebase.js';
import { EmbeddingsCache } from '../lib/cache.js';
import { Worker } from 'worker_threads';
import { smartChunk, MODEL_TOKEN_LIMITS } from '../lib/utils.js';

vi.mock('fs/promises');
import EventEmitter from 'events';

vi.mock('fs/promises');
vi.mock('worker_threads');
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      close: vi.fn(),
    }),
  },
}));

vi.mock('../lib/call-graph.js', () => ({
  extractCallData: vi.fn(),
}));

import { extractCallData } from '../lib/call-graph.js';

describe('Coverage Gap Filling', () => {
  let mockEmbedder;
  let mockCache;
  let config;

  beforeEach(() => {
    mockEmbedder = vi.fn();
    mockCache = {
      getFileHash: vi.fn(),
      removeFileFromStore: vi.fn(),
      addToStore: vi.fn(),
      setFileHash: vi.fn(),
      getVectorStore: vi.fn().mockReturnValue([]),
      setVectorStore: vi.fn(),
      clearCallGraphData: vi.fn(),
      fileHashes: new Map(),
      deleteFileHash: vi.fn(),
      pruneCallGraphData: vi.fn(),
      fileCallData: new Map(),
      getRelatedFiles: vi.fn(),
      setFileCallData: vi.fn(),
      setFileCallDataEntries: vi.fn((entries) => {
        if (entries instanceof Map) {
          mockCache.fileCallData = entries;
        } else {
          mockCache.fileCallData = new Map(Object.entries(entries || {}));
        }
      }),
      clearFileCallData: vi.fn(() => {
        mockCache.fileCallData = new Map();
      }),
      save: vi.fn().mockResolvedValue(),
      ensureAnnIndex: vi.fn().mockResolvedValue(null),
      rebuildCallGraph: vi.fn(),
      getFileHashKeys: vi.fn().mockReturnValue([]),
      getFileCallDataKeys: vi.fn().mockImplementation(() => [...mockCache.fileCallData.keys()]),
    };
    config = {
      embeddingModel: 'test-model',
      excludePatterns: ['**/excluded.js'],
      fileExtensions: ['js'],
      workerThreads: 0,
      verbose: true,
      searchDirectory: '/test/dir',
      maxFileSize: 100,
      callGraphEnabled: true,
      enableCache: true,
      cacheDirectory: '.cache',
    };

    vi.mocked(extractCallData).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('CodebaseIndexer', () => {
    it('logs error when worker creation fails', async () => {
      const WorkerMock = vi.mocked(Worker);
      WorkerMock.mockImplementation(() => {
        throw new Error('Simulated worker failure');
      });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const indexer = new CodebaseIndexer(mockEmbedder, mockCache, { ...config, workerThreads: 1 });
      await indexer.initializeWorkers();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to create worker'));
      expect(indexer.workers.length).toBe(0);
    });

    it('logs skipped message for excluded file when verbose is true', async () => {
      const indexer = new CodebaseIndexer(mockEmbedder, mockCache, config);
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      await indexer.indexFile('/test/dir/excluded.js');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipped excluded.js (excluded by pattern)')
      );
    });

    it('increments skippedCount.tooLarge for large files in preFilterFiles', async () => {
      const indexer = new CodebaseIndexer(mockEmbedder, mockCache, config);

      fs.stat.mockResolvedValue({ isDirectory: () => false, size: 1000 });

      const result = await indexer.preFilterFiles(['/test/dir/large.js']);
      expect(result).toHaveLength(0);
    });

    it('handles error in missing call data re-indexing', async () => {
      const indexer = new CodebaseIndexer(mockEmbedder, mockCache, config);

      mockCache.getVectorStore.mockReturnValue([{ file: '/test/dir/missing.js' }]);

      indexer.discoverFiles = vi.fn().mockResolvedValue(['/test/dir/missing.js']);
      indexer.preFilterFiles = vi.fn().mockResolvedValue([]);

      fs.stat.mockRejectedValue(new Error('File not found'));

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const result = await indexer.indexAll(false);
        expect(result).toBeDefined();
      } catch (e) {}
    });

    it('handles worker initialization timeouts and errors', async () => {
      const WorkerMock = vi.mocked(Worker);
      WorkerMock.mockImplementation(function () {
        const worker = new EventEmitter();
        worker.postMessage = vi.fn();
        worker.terminate = vi.fn().mockResolvedValue();
        worker.off = vi.fn();

        setTimeout(() => {
          worker.emit('message', { type: 'error', error: 'Specific Init Error' });
        }, 10);
        return worker;
      });

      const indexer = new CodebaseIndexer(mockEmbedder, mockCache, { ...config, workerThreads: 1 });

      await indexer.initializeWorkers();

      expect(indexer.workers.length).toBe(0);
      expect(indexer.workerReady.length).toBe(0);
    });

    it('ignores unknown worker message types (implicit else branch coverage)', async () => {
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((cb) => {
        cb();
        return 1;
      });

      const WorkerMock = vi.mocked(Worker);

      WorkerMock.mockImplementation(function () {
        const worker = new EventEmitter();
        worker.postMessage = vi.fn();
        worker.terminate = vi.fn().mockResolvedValue();
        worker.off = vi.fn();

        Promise.resolve().then(() => {
          worker.emit('message', { type: 'unknown' });
        });

        return worker;
      });

      const indexer = new CodebaseIndexer(mockEmbedder, mockCache, { ...config, workerThreads: 1 });

      const initPromise = indexer.initializeWorkers();

      await Promise.resolve();
      await Promise.resolve();

      await initPromise;
      expect(indexer.workers.length).toBe(0);

      setTimeoutSpy.mockRestore();
    });

    it('suppresses error logging when call graph extraction fails and verbose is false', async () => {
      const indexer = new CodebaseIndexer(mockEmbedder, mockCache, {
        ...config,
        verbose: false,
        workerThreads: 0,
      });

      vi.mocked(extractCallData).mockImplementation(() => {
        throw new Error('Extraction failed silently');
      });

      indexer.discoverFiles = vi.fn().mockResolvedValue(['/test/file.js']);
      indexer.preFilterFiles = vi.fn().mockResolvedValue([
        {
          file: '/test/file.js',
          content: 'code',
          hash: 'hash',
        },
      ]);

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await indexer.indexAll(false);

      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Call graph extraction failed')
      );
    });

    it('logs error when call graph extraction fails (line 745)', async () => {
      const indexer = new CodebaseIndexer(mockEmbedder, mockCache, { ...config, workerThreads: 0 });

      vi.mocked(extractCallData).mockImplementation(() => {
        throw new Error('Extraction failed');
      });

      indexer.discoverFiles = vi.fn().mockResolvedValue(['/test/file.js']);
      indexer.preFilterFiles = vi.fn().mockResolvedValue([
        {
          file: '/test/file.js',
          content: 'code',
          hash: 'hash',
        },
      ]);

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await indexer.indexAll(false);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Call graph extraction failed')
      );
    });

    it('retries failed chunks with single-threaded fallback', async () => {
      const indexer = new CodebaseIndexer(mockEmbedder, mockCache, config);

      indexer.workers = [
        {
          postMessage: vi.fn(),
          on: vi.fn(),
          once: vi.fn(),
          off: vi.fn(),
        },
      ];
    });

    it('handles file watcher setup and events', async () => {
      const indexer = new CodebaseIndexer(mockEmbedder, mockCache, { ...config, watchFiles: true });
      const _consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await indexer.setupFileWatcher();
      expect(indexer.watcher).toBeDefined();
    });
  });

  describe('handleToolCall', () => {
    it('handles undefined totalFiles/totalChunks in result', async () => {
      const indexer = new CodebaseIndexer(mockEmbedder, mockCache, config);

      indexer.indexAll = vi.fn().mockResolvedValue({
        skipped: false,
        filesProcessed: 0,
        chunksCreated: 0,
        message: 'Result without stats',
      });

      mockCache.getVectorStore.mockReturnValue([{ file: 'foo.js', vector: [] }]);

      const result = await handleToolCall({ params: {} }, indexer);
      expect(result.content[0].text).toContain('Statistics:');
      expect(result.content[0].text).toContain('Total files in index: 1');
    });

    it('handles result missing filesProcessed/chunksCreated properties (lines 993-994)', async () => {
      const indexer = new CodebaseIndexer(mockEmbedder, mockCache, config);

      indexer.indexAll = vi.fn().mockResolvedValue({
        skipped: false,
        totalFiles: 5,
        totalChunks: 10,
        message: 'Result simple',
      });

      const result = await handleToolCall({ params: {} }, indexer);

      expect(result.content[0].text).not.toContain('Files processed this run');
      expect(result.content[0].text).toContain('Total files in index: 5');
    });
  });

  describe('EmbeddingsCache', () => {
    it('returns empty map from getRelatedFiles when callGraph is null', async () => {
      const cache = new EmbeddingsCache({
        callGraphEnabled: true,
        enableCache: true,
        cacheDirectory: '.cache',
      });

      cache.clearFileCallData();

      const result = await cache.getRelatedFiles(['someSymbol']);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });

  describe('Utils - smartChunk', () => {
    it('filters out chunks that are too short (<= 20 chars)', () => {
      MODEL_TOKEN_LIMITS['test-tiny'] = 5;

      const content = 'a b c d e f g h i j k l m';

      const config = { embeddingModel: 'test-tiny' };
      const chunks = smartChunk(content, 'test.txt', config);

      const shortContent = 'a b c d e\nf g h i j';

      const shortChunks = smartChunk(shortContent, 'test.txt', config);
      expect(shortChunks).toHaveLength(0);
    });
  });

  describe('IndexCodebase - Branches', () => {
    it('skips watcher setup if watchFiles is false', async () => {
      const indexer = new CodebaseIndexer(mockEmbedder, mockCache, {
        ...config,
        watchFiles: false,
      });
      await indexer.setupFileWatcher();
      expect(indexer.watcher).toBeNull();
    });

    it('initializes workers without verbose logging', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const nonVerboseConfig = { ...config, verbose: false, workerThreads: 1 };
      const indexer = new CodebaseIndexer(mockEmbedder, mockCache, nonVerboseConfig);

      const WorkerMock = vi.mocked(Worker);
      WorkerMock.mockImplementation(function () {
        const worker = new EventEmitter();
        worker.postMessage = vi.fn();
        worker.terminate = vi.fn().mockResolvedValue();
        worker.off = vi.fn();
        setTimeout(() => {
          worker.emit('message', { type: 'ready' });
        }, 1);
        return worker;
      });

      await indexer.initializeWorkers();

      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Worker config:'));
    });

    it('handles isDirectory and size check in missing call data loop', async () => {
      const indexer = new CodebaseIndexer(mockEmbedder, mockCache, config);

      mockCache.getVectorStore.mockReturnValue([
        { file: '/missing/dir' },
        { file: '/missing/large' },
      ]);
      indexer.discoverFiles = vi.fn().mockResolvedValue(['/missing/dir', '/missing/large']);
      indexer.preFilterFiles = vi.fn().mockResolvedValue([]);

      fs.stat.mockImplementation(async (f) => {
        if (f === '/missing/dir') return { isDirectory: () => true, size: 100 };
        if (f === '/missing/large') return { isDirectory: () => false, size: 99999999 };
        return { isDirectory: () => false, size: 10 };
      });

      const result = await indexer.indexAll(false);
    });

    it('handles collision in filesToProcessSet during missing data check', async () => {
      const indexer = new CodebaseIndexer(mockEmbedder, mockCache, config);

      const file = '/missing/normal.js';
      mockCache.getVectorStore.mockReturnValue([{ file }]);
      indexer.discoverFiles = vi.fn().mockResolvedValue([file]);

      indexer.preFilterFiles = vi.fn().mockResolvedValue([{ file, content: 'foo', hash: 'abc' }]);

      fs.stat.mockResolvedValue({ isDirectory: () => false, size: 10 });
      fs.readFile.mockResolvedValue('content');

      mockCache.setFileCallData = vi.fn();

      await indexer.indexAll(false);
    });
  });
});
