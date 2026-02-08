import { vi } from 'vitest';
import os from 'os';

// Mock os.cpus
vi.mock('os', async () => {
  const actual = await vi.importActual('os');
  return {
    ...actual,
    cpus: vi.fn().mockReturnValue(Array(4).fill({})),
  };
});

let workerMode = 'ready';

// Mock Worker
vi.mock('worker_threads', () => {
  class MockWorker {
    constructor() {
      this.once = vi.fn((event, handler) => {
        if (event === 'message') {
          if (workerMode === 'ready') {
            setImmediate(() => handler({ type: 'ready' }));
          } else if (workerMode === 'error') {
            setImmediate(() => handler({ type: 'error', error: 'boom' }));
          }
        }
        if (event === 'error' && workerMode === 'crash') {
          setImmediate(() => handler(new Error('crash')));
        }
      });
      this.on = vi.fn();
      this.off = vi.fn();
      this.postMessage = vi.fn();
      this.terminate = vi.fn().mockResolvedValue(undefined);
    }
  }
  return { Worker: MockWorker };
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CodebaseIndexer } from '../features/index-codebase.js';
import * as utils from '../lib/utils.js';
import fs from 'fs/promises';
import path from 'path';
import { Worker } from 'worker_threads';

// Store handlers
const handlers = {};
const mockWatcher = {
  on: vi.fn((event, handler) => {
    handlers[event] = handler;
    return mockWatcher;
  }),
  close: vi.fn().mockResolvedValue(undefined),
};

// Mock dependencies
vi.mock('fs/promises');
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => mockWatcher),
  },
}));

describe('CodebaseIndexer Branch Coverage', () => {
  let indexer;
  let mockEmbedder;
  let mockCache;
  let mockConfig;
  let mockServer;

  beforeEach(() => {
    // Ensure we start with real timers
    vi.useRealTimers();
    workerMode = 'ready';

    for (const key in handlers) delete handlers[key];

    mockEmbedder = vi.fn().mockResolvedValue({ data: [0.1, 0.2, 0.3] });
    mockCache = {
      getFileHash: vi.fn(),
      setFileHash: vi.fn(),
      removeFileFromStore: vi.fn(),
      dropInMemoryVectors: vi.fn().mockResolvedValue(undefined),
      addToStore: vi.fn(),
      deleteFileHash: vi.fn(),
      save: vi.fn(),
      clearCallGraphData: vi.fn(),
      getVectorStore: vi.fn().mockReturnValue([]),
      setVectorStore: vi.fn(),
      ensureAnnIndex: vi.fn().mockResolvedValue(null),
      pruneCallGraphData: vi.fn(),
      fileCallData: new Map(),
      fileHashes: new Map(),
      rebuildCallGraph: vi.fn(),
      setFileCallData: vi.fn(),
      getAnnVector: vi.fn().mockReturnValue(new Float32Array([0.1])),
      setLastIndexDuration: vi.fn(),
      setLastIndexStats: vi.fn(),
      getFileHashKeys: vi.fn().mockImplementation(() => [...mockCache.fileHashes.keys()]),
      setFileHashes: vi.fn((map) => {
        mockCache.fileHashes = map;
      }),
      getFileCallDataKeys: vi.fn().mockImplementation(() => [...mockCache.fileCallData.keys()]),
      setFileCallDataEntries: vi.fn((map) => {
        mockCache.fileCallData = map;
      }),
      clearFileCallData: vi.fn(() => {
        mockCache.fileCallData = new Map();
      }),
    };
    mockConfig = {
      searchDirectory: '/test',
      fileExtensions: ['js'],
      fileNames: ['.gitignore'],
      excludePatterns: [],
      maxFileSize: 1024 * 1024,
      batchSize: 10,
      verbose: true,
      callGraphEnabled: false,
      watchFiles: true,
      workerThreads: 1,
      embeddingModel: 'test-model',
    };
    mockServer = {
      hybridSearch: {
        clearFileModTime: vi.fn(),
      },
      sendNotification: vi.fn(),
    };

    indexer = new CodebaseIndexer(mockEmbedder, mockCache, mockConfig, mockServer);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('re-initializes workers when thread configuration changes', async () => {
    indexer.config.workerThreads = 'auto';
    vi.spyOn(os, 'cpus').mockReturnValue([{}]);
    await indexer.initializeWorkers();

    indexer.config.workerThreads = 2;
    await indexer.initializeWorkers();
  });

  it('applies heavy-model auto worker safety policy', async () => {
    indexer.config.workerThreads = 'auto';
    indexer.config.embeddingModel = 'jinaai/jina-embeddings-v2-base-code';
    vi.spyOn(os, 'cpus').mockReturnValue(Array(8).fill({}));
    vi.spyOn(os, 'freemem').mockReturnValue(32 * 1024 * 1024 * 1024);
    vi.spyOn(os, 'totalmem').mockReturnValue(64 * 1024 * 1024 * 1024);

    await indexer.initializeWorkers();

    const expectedWorkers = process.platform === 'win32' ? 1 : 2;
    expect(indexer.workers.length).toBe(expectedWorkers);
  });

  it('covers initializeWorkers timeout branch', async () => {
    vi.useFakeTimers();
    workerMode = 'none';
    indexer.config.workerThreads = 2;
    const promise = indexer.initializeWorkers();

    // Advance time to trigger timeout
    vi.advanceTimersByTime(130000);

    // The timeout callback rejects the promise, which is caught in initializeWorkers
    await promise;
  });

  it('ignores control responses without pending child requests', () => {
    indexer._embeddingChildQueue = [];
    indexer._embeddingChildBuffer = '';
    indexer._embeddingChildStopping = false;

    indexer._handleEmbeddingChildStdout(Buffer.from('{"success":true,"wasLoaded":true}\n'));

    expect(console.warn).not.toHaveBeenCalledWith(
      '[Indexer] Persistent embedding response with no pending request'
    );
  });

  it('still warns for unexpected embedding responses without pending child requests', () => {
    indexer._embeddingChildQueue = [];
    indexer._embeddingChildBuffer = '';
    indexer._embeddingChildStopping = false;

    indexer._handleEmbeddingChildStdout(Buffer.from('{"results":[{"ok":true}]}\n'));

    expect(console.warn).toHaveBeenCalledWith(
      '[Indexer] Persistent embedding response with no pending request'
    );
  });

  it('logs warning when worker initialization fails', async () => {
    indexer.config.workerThreads = 2;
    workerMode = 'error';
    await indexer.initializeWorkers();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Worker initialization failed')
    );
  });

  it('handles various worker message types correctly', async () => {
    const mockWorker = {
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      postMessage: vi.fn(),
    };
    indexer.workers = [mockWorker];

    const chunks = [{ file: 'test.js', text: 'code' }];
    const promise = indexer.processChunksWithWorkers(chunks);

    const handler = mockWorker.on.mock.calls.find((call) => call[0] === 'message')[1];

    handler({ batchId: 'wrong' }); // L249 false

    const batchId = mockWorker.postMessage.mock.calls[0][0].batchId;
    handler({ batchId, type: 'unknown' }); // L254 unknown
    handler({ batchId, type: 'error', error: 'fail' }); // L254 error

    const results = await promise;
    expect(results).toHaveLength(1); // Fallback ran
  });

  it('falls back to single-threaded execution on worker error', async () => {
    const mockWorker = {
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      postMessage: vi.fn(),
    };
    indexer.workers = [mockWorker];
    const fallbackSpy = vi
      .spyOn(indexer, 'processChunksSingleThreaded')
      .mockResolvedValue([{ success: true }]);

    const promise = indexer.processChunksWithWorkers([{ file: 'a.js', text: 'c' }]);
    const handler = mockWorker.on.mock.calls.find((call) => call[0] === 'message')[1];
    const batchId = mockWorker.postMessage.mock.calls[0][0].batchId;
    handler({ batchId, type: 'error', error: 'boom' });

    await promise;
    expect(fallbackSpy).toHaveBeenCalled();
  });

  it('covers processChunksWithWorkers reset timeout and done=false branch', async () => {
    vi.useFakeTimers();
    const mockWorker = {
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      postMessage: vi.fn(),
    };
    indexer.workers = [mockWorker];
    const fallbackSpy = vi
      .spyOn(indexer, 'processChunksSingleThreaded')
      .mockResolvedValue([{ success: true }]);

    const promise = indexer.processChunksWithWorkers([{ file: 'a.js', text: 'c' }]);
    const handler = mockWorker.on.mock.calls.find((call) => call[0] === 'message')[1];
    const batchId = mockWorker.postMessage.mock.calls[0][0].batchId;

    handler({
      batchId,
      type: 'results',
      results: [{ success: true }],
      done: false,
    });

    vi.advanceTimersByTime(1000);

    await promise;
    expect(fallbackSpy).toHaveBeenCalled();
  });

  it('covers processChunksWithWorkers postMessage failure', async () => {
    const mockWorker = {
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      postMessage: vi.fn(() => {
        throw new Error('post boom');
      }),
    };
    indexer.workers = [mockWorker];
    const fallbackSpy = vi
      .spyOn(indexer, 'processChunksSingleThreaded')
      .mockResolvedValue([{ success: true }]);

    await indexer.processChunksWithWorkers([{ file: 'a.js', text: 'c' }]);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('postMessage failed'));
    expect(fallbackSpy).toHaveBeenCalled();
  });

  it('returns empty array when input chunks are empty', async () => {
    const mockWorker = {
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      postMessage: vi.fn(),
    };
    indexer.workers = [mockWorker];
    const results = await indexer.processChunksWithWorkers([]);
    expect(results).toEqual([]);
  });

  it('covers processChunksWithWorkers worker crash and timeout', async () => {
    vi.useFakeTimers();
    const mockWorker = {
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      postMessage: vi.fn(),
    };
    indexer.workers = [mockWorker];

    const promise = indexer.processChunksWithWorkers([{ file: 'a.js', text: 'c' }]);

    // 1. Crash
    const errorHandler = mockWorker.once.mock.calls.find((c) => c[0] === 'error')[1];
    errorHandler(new Error('crash'));

    // 2. Timeout
    const promise2 = indexer.processChunksWithWorkers([{ file: 'b.js', text: 'c' }]);
    vi.advanceTimersByTime(310000);

    await promise;
    await promise2;
  });

  it('covers missing call-graph stats guard (invalid stat)', async () => {
    indexer.config.callGraphEnabled = true;
    indexer.config.verbose = false;
    indexer.discoverFiles = vi.fn().mockResolvedValue(['/test/a.js']);
    indexer.preFilterFiles = vi.fn().mockResolvedValue([]);
    mockCache.getVectorStore.mockReturnValue([{ file: '/test/a.js' }]);
    mockCache.clearFileCallData();
    vi.spyOn(fs, 'stat').mockResolvedValue({});

    const result = await indexer.indexAll();

    expect(result?.message).toBe('All files up to date');
    expect(fs.stat).toHaveBeenCalledWith('/test/a.js');
  });

  it('logs warning when file indexing fails (verbose mode)', async () => {
    indexer.config.verbose = true;
    indexer.config.workerThreads = 0;
    vi.spyOn(fs, 'stat').mockResolvedValue({ isDirectory: () => false, size: 100, mtimeMs: 123 });
    vi.spyOn(fs, 'readFile').mockResolvedValue('content');
    vi.spyOn(utils, 'hashContent').mockReturnValue('new-hash');
    mockCache.getFileHash.mockReturnValue('old-hash');

    vi.spyOn(utils, 'smartChunk').mockReturnValue([{ text: 'chunk1', startLine: 1, endLine: 2 }]);
    mockEmbedder.mockRejectedValue(new Error('fail'));

    await indexer.indexFile(path.join(mockConfig.searchDirectory, 'file.js'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Skipped hash update'));
  });

  it('logs embedding runtime summary during indexFile', async () => {
    indexer.config.verbose = false;
    indexer.config.workerThreads = 0;
    vi.spyOn(fs, 'stat').mockResolvedValue({ isDirectory: () => false, size: 100, mtimeMs: 123 });
    vi.spyOn(fs, 'readFile').mockResolvedValue('content');
    vi.spyOn(utils, 'hashContent').mockReturnValue('new-hash');
    mockCache.getFileHash.mockReturnValue('old-hash');
    vi.spyOn(utils, 'smartChunk').mockReturnValue([{ text: 'chunk1', startLine: 1, endLine: 2 }]);

    await indexer.indexFile(path.join(mockConfig.searchDirectory, 'file.js'));

    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('Embedding runtime: mode=main-thread onnxThreads=auto')
    );
  });

  it('updates file hash registry after successful indexing', async () => {
    indexer.config.verbose = false;
    indexer.config.batchSize = 1;
    indexer.config.workerThreads = 0;
    indexer.config.allowSingleThreadFallback = true;

    indexer.discoverFiles = vi.fn().mockResolvedValue(['/test/a.js']);
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/test/a.js', content: 'c', hash: 'h' }]);
    vi.spyOn(utils, 'smartChunk').mockReturnValue([{ text: 'chunk', startLine: 1, endLine: 1 }]);
    indexer.processChunksSingleThreaded = vi
      .fn()
      .mockResolvedValue([
        { success: true, file: '/test/a.js', startLine: 1, endLine: 1, vector: [0.1] },
      ]);

    await indexer.indexAll();
    expect(mockCache.setFileHash).toHaveBeenCalled();
  });

  it('logs warnings for hash skip and ANN failures', async () => {
    indexer.config.verbose = true;
    indexer.config.batchSize = 1;
    indexer.config.workerThreads = 0;
    indexer.config.allowSingleThreadFallback = true;
    indexer.discoverFiles = vi.fn().mockResolvedValue(['/test/a.js']);
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/test/a.js', content: 'c', hash: 'h' }]);
    vi.spyOn(utils, 'smartChunk').mockReturnValue([{ text: 'chunk', startLine: 1, endLine: 1 }]);
    indexer.processChunksSingleThreaded = vi
      .fn()
      .mockResolvedValue([
        { success: false, file: '/test/a.js', startLine: 1, endLine: 1, error: 'fail' },
      ]);
    mockCache.ensureAnnIndex.mockRejectedValue(new Error('ANN Boom'));

    await indexer.indexAll();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Skipped hash update'));
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Background ANN build failed')
    );
  });

  it('logs skip warnings in verbose mode', async () => {
    indexer.config.verbose = true;
    indexer.config.batchSize = 1;
    indexer.config.workerThreads = 0;
    indexer.config.allowSingleThreadFallback = true;

    indexer.discoverFiles = vi.fn().mockResolvedValue(['/test/a.js']);
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/test/a.js', content: 'c', hash: 'h' }]);

    vi.spyOn(utils, 'smartChunk').mockReturnValue([{ text: 'chunk' }]);

    indexer.processChunksSingleThreaded = vi
      .fn()
      .mockResolvedValue([{ success: false, file: '/test/a.js', error: 'fail' }]);

    mockCache.ensureAnnIndex.mockRejectedValue(new Error('ANN Boom'));

    await indexer.indexAll();

    // Wait for background promise
    await new Promise((resolve) => setImmediate(resolve));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Skipped hash update'));
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Background ANN build failed')
    );
  });

  it('processes batches and tracks progress', async () => {
    indexer.config.verbose = false;
    indexer.config.batchSize = 1;

    indexer.discoverFiles = vi.fn().mockResolvedValue(['a', 'b', 'c', 'd']);
    indexer.preFilterFiles = vi.fn().mockResolvedValue([
      { file: 'a', content: 'c', hash: 'h' },
      { file: 'b', content: 'c', hash: 'h' },
      { file: 'c', content: 'c', hash: 'h' },
      { file: 'd', content: 'c', hash: 'h' },
    ]);

    indexer.processChunksSingleThreaded = vi.fn().mockImplementation(async (chunks) => {
      return chunks.map((c) => ({ success: true, file: c.file, vector: [0.1] }));
    });

    await indexer.indexAll();
  });

  it('logs when queued watch events processing fails', async () => {
    indexer.discoverFiles = vi.fn().mockResolvedValue([]);
    indexer.processPendingWatchEvents = vi.fn().mockRejectedValue(new Error('queue boom'));

    await indexer.indexAll();

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to apply queued file updates')
    );
  });

  it('overwrites queued unlink when a new event arrives', () => {
    const filePath = '/test/file.js';
    indexer.pendingWatchEvents.set(filePath, 'unlink');

    CodebaseIndexer.prototype.enqueueWatchEvent.call(indexer, 'change', filePath);

    expect(indexer.pendingWatchEvents.get(filePath)).toBe('change');
  });

  it('covers setupFileWatcher branches', async () => {
    indexer.config.watchFiles = true;
    await indexer.setupFileWatcher();
    await indexer.setupFileWatcher();

    // TRUE branches
    await handlers['add']('file.js');
    await handlers['change']('file.js');
    await handlers['unlink']('file.js');

    // FALSE branches
    indexer.server = null;
    await handlers['add']('file.js');
  });

  it('skips files provided with content if too large', async () => {
    indexer.discoverFiles = vi.fn().mockResolvedValue(['file-large-content.js']);
    // Mock preFilterFiles to return an entry with content that exceeds maxFileSize
    indexer.preFilterFiles = vi.fn().mockResolvedValue([
      {
        file: 'file-large-content.js',
        content: 'x'.repeat(mockConfig.maxFileSize + 100),
        hash: 'hash1',
        force: false,
      },
    ]);

    await indexer.indexAll();

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipped file-large-content.js (too large:')
    );
    expect(mockEmbedder).not.toHaveBeenCalled();
  });

  it('skips files with invalid stat results', async () => {
    indexer.discoverFiles = vi.fn().mockResolvedValue(['invalid-stat.js']);
    indexer.preFilterFiles = vi.fn().mockResolvedValue([{ file: 'invalid-stat.js', force: false }]);

    vi.spyOn(fs, 'stat').mockResolvedValue(null);

    await indexer.indexAll();

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid stat result for invalid-stat.js')
    );
  });

  it('skips files that are too large via stat check', async () => {
    indexer.discoverFiles = vi.fn().mockResolvedValue(['large-stat.js']);
    indexer.preFilterFiles = vi.fn().mockResolvedValue([{ file: 'large-stat.js', force: false }]);

    vi.spyOn(fs, 'stat').mockResolvedValue({
      isDirectory: () => false,
      size: mockConfig.maxFileSize + 100,
      mtimeMs: 123,
    });

    await indexer.indexAll();

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipped large-stat.js (too large:')
    );
  });

  it('handles read file failures', async () => {
    indexer.discoverFiles = vi.fn().mockResolvedValue(['read-error.js']);
    indexer.preFilterFiles = vi.fn().mockResolvedValue([{ file: 'read-error.js', force: false }]);

    vi.spyOn(fs, 'stat').mockResolvedValue({
      isDirectory: () => false,
      size: 50,
      mtimeMs: 123,
    });
    vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('Read failed'));

    await indexer.indexAll();

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read read-error.js: Read failed')
    );
  });

  it('re-reads file content when worker retry result has no inline content', async () => {
    indexer.config.verbose = true;
    indexer.config.workerThreads = 1;
    indexer.config.allowSingleThreadFallback = true;
    indexer.config.maxFileSize = 1024;

    indexer.shouldUseWorkers = vi.fn().mockReturnValue(true);
    indexer.initializeWorkers = vi.fn(async () => {
      indexer.workers = [{ once: vi.fn(), postMessage: vi.fn(), terminate: vi.fn(), off: vi.fn() }];
    });
    indexer.terminateWorkers = vi.fn().mockResolvedValue(undefined);

    indexer.discoverFiles = vi.fn().mockResolvedValue(['/test/retry.js']);
    indexer.preFilterFiles = vi.fn().mockResolvedValue([
      { file: '/test/retry.js', force: false, size: 20, mtimeMs: 10 },
    ]);
    indexer.processFilesWithWorkers = vi
      .fn()
      .mockResolvedValue([{ file: '/test/retry.js', status: 'retry' }]);
    indexer.processChunksSingleThreaded = vi
      .fn()
      .mockResolvedValue([
        {
          success: true,
          file: '/test/retry.js',
          startLine: 1,
          endLine: 1,
          content: 'const x = 1;',
          vector: [0.1],
        },
      ]);

    vi.spyOn(fs, 'stat').mockResolvedValue({
      isDirectory: () => false,
      size: 20,
      mtimeMs: 123,
    });
    vi.spyOn(fs, 'readFile').mockResolvedValue('const x = 1;');

    const result = await indexer.indexAll();

    expect(result?.skipped).toBe(false);
    expect(fs.readFile).toHaveBeenCalledWith('/test/retry.js', 'utf-8');
    expect(mockCache.setFileHash).toHaveBeenCalledWith(
      '/test/retry.js',
      expect.any(String),
      expect.objectContaining({ size: 20, mtimeMs: 123 })
    );
  });

  it('respects enableExplicitGc in explicit GC helper', () => {
    const originalGc = global.gc;
    const gcSpy = vi.fn();
    global.gc = gcSpy;

    indexer.config.enableExplicitGc = false;
    expect(indexer.runExplicitGc({ force: true })).toBe(false);
    expect(gcSpy).not.toHaveBeenCalled();

    indexer.config.enableExplicitGc = true;
    expect(indexer.runExplicitGc({ force: true })).toBe(true);
    expect(gcSpy).toHaveBeenCalledTimes(1);

    global.gc = originalGc;
  });

  it('throttles explicit GC by min interval', async () => {
    vi.useFakeTimers();
    const originalGc = global.gc;
    const gcSpy = vi.fn();
    global.gc = gcSpy;
    indexer.config.enableExplicitGc = true;

    expect(indexer.runExplicitGc({ minIntervalMs: 1000 })).toBe(true);
    expect(indexer.runExplicitGc({ minIntervalMs: 1000 })).toBe(false);
    expect(gcSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(indexer.runExplicitGc({ minIntervalMs: 1000 })).toBe(true);
    expect(gcSpy).toHaveBeenCalledTimes(2);

    global.gc = originalGc;
  });

  it('uses dedicated embedding-process GC config instead of incremental GC threshold', () => {
    indexer.config.incrementalGcThresholdMb = 64;
    indexer.config.embeddingProcessGcRssThresholdMb = undefined;
    indexer.config.embeddingProcessGcMinIntervalMs = undefined;
    indexer.config.embeddingProcessGcMaxRequestsWithoutCollection = undefined;

    const gcConfig = indexer.getEmbeddingProcessGcConfig();

    expect(gcConfig.gcRssThresholdMb).toBe(2048);
    expect(gcConfig.gcMinIntervalMs).toBe(15000);
    expect(gcConfig.gcMaxRequestsWithoutCollection).toBe(8);
  });

  it('runs post-incremental cleanup with model unload when configured', async () => {
    indexer.config.clearCacheAfterIndex = true;
    indexer.config.unloadModelAfterIndex = true;
    indexer.config.verbose = false;
    indexer.cache.dropInMemoryVectors = vi.fn().mockResolvedValue(undefined);
    indexer.unloadEmbeddingModels = vi.fn().mockResolvedValue({});
    const gcSpy = vi.spyOn(indexer, 'runExplicitGc').mockReturnValue(true);

    await indexer.runPostIncrementalCleanup('watch update');

    expect(indexer.cache.dropInMemoryVectors).toHaveBeenCalledTimes(1);
    expect(indexer.unloadEmbeddingModels).toHaveBeenCalledTimes(1);
    expect(gcSpy).toHaveBeenCalledWith({ force: true });
  });

  it('recycles server after incremental cleanup when RSS stays above threshold', async () => {
    vi.useFakeTimers();
    indexer.config.clearCacheAfterIndex = false;
    indexer.config.unloadModelAfterIndex = false;
    indexer.config.verbose = false;
    indexer.config.recycleServerOnHighRssAfterIncremental = true;
    indexer.config.recycleServerOnHighRssThresholdMb = 1024;
    indexer.config.recycleServerOnHighRssCooldownMs = 0;
    indexer.config.recycleServerOnHighRssDelayMs = 100;
    indexer.config.enableExplicitGc = false;

    const memorySpy = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 2 * 1024 * 1024 * 1024,
      heapUsed: 128 * 1024 * 1024,
      heapTotal: 256 * 1024 * 1024,
      external: 64 * 1024 * 1024,
      arrayBuffers: 32 * 1024 * 1024,
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

    await indexer.runPostIncrementalCleanup('watch update');
    vi.advanceTimersByTime(100);

    expect(exitSpy).toHaveBeenCalledWith(0);
    memorySpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('cancels high-RSS recycle when memory drops before delay elapses', async () => {
    vi.useFakeTimers();
    indexer.config.clearCacheAfterIndex = false;
    indexer.config.unloadModelAfterIndex = false;
    indexer.config.verbose = true;
    indexer.config.recycleServerOnHighRssAfterIncremental = true;
    indexer.config.recycleServerOnHighRssThresholdMb = 1024;
    indexer.config.recycleServerOnHighRssCooldownMs = 0;
    indexer.config.recycleServerOnHighRssDelayMs = 100;
    indexer.config.enableExplicitGc = false;

    const memorySpy = vi
      .spyOn(process, 'memoryUsage')
      .mockReturnValueOnce({
        rss: 2 * 1024 * 1024 * 1024,
        heapUsed: 128 * 1024 * 1024,
        heapTotal: 256 * 1024 * 1024,
        external: 64 * 1024 * 1024,
        arrayBuffers: 32 * 1024 * 1024,
      })
      .mockReturnValueOnce({
        rss: 512 * 1024 * 1024,
        heapUsed: 96 * 1024 * 1024,
        heapTotal: 192 * 1024 * 1024,
        external: 32 * 1024 * 1024,
        arrayBuffers: 16 * 1024 * 1024,
      });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

    await indexer.runPostIncrementalCleanup('watch update');
    vi.advanceTimersByTime(100);

    expect(exitSpy).not.toHaveBeenCalled();
    memorySpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('logs incremental memory trace phases when enabled', async () => {
    indexer.config.incrementalMemoryProfile = true;
    indexer.config.clearCacheAfterIndex = true;
    indexer.config.unloadModelAfterIndex = false;
    indexer.config.recycleServerOnHighRssAfterIncremental = false;
    indexer.config.verbose = false;

    await indexer.runPostIncrementalCleanup('watch update');

    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('[Indexer][MemTrace] incremental.dropInMemoryVectors')
    );
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('[Indexer][MemTrace] incremental.explicitGc')
    );
  });

  it('skips unchanged files when hash matches', async () => {
    indexer.discoverFiles = vi.fn().mockResolvedValue(['unchanged.js']);
    indexer.preFilterFiles = vi.fn().mockResolvedValue([{ file: 'unchanged.js', force: false }]);

    vi.spyOn(fs, 'stat').mockResolvedValue({
      isDirectory: () => false,
      size: 50,
      mtimeMs: 123,
    });
    vi.spyOn(fs, 'readFile').mockResolvedValue('content');

    vi.spyOn(utils, 'hashContent').mockReturnValue('same-hash');
    mockCache.getFileHash.mockReturnValue('same-hash');

    await indexer.indexAll();

    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipped unchanged.js (unchanged)')
    );
    expect(mockEmbedder).not.toHaveBeenCalled();
  });

  it('queues watch events when indexing is in progress', async () => {
    await indexer.setupFileWatcher();

    // Simulate indexing in progress
    indexer.isIndexing = true;

    // Trigger ADD event
    await handlers['add']('added.js');
    expect(indexer.pendingWatchEvents.get(path.join('/test', 'added.js'))).toBe('add');
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('Queued add event during indexing')
    );

    // Trigger CHANGE event
    await handlers['change']('changed.js');
    expect(indexer.pendingWatchEvents.get(path.join('/test', 'changed.js'))).toBe('change');
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('Queued change event during indexing')
    );

    // Trigger UNLINK event
    await handlers['unlink']('deleted.js');
    expect(indexer.pendingWatchEvents.get(path.join('/test', 'deleted.js'))).toBe('unlink');
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('Queued delete event during indexing')
    );
  });
});
