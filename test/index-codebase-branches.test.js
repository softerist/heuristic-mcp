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
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('covers initializeWorkers config branches (L93, L95)', async () => {
    indexer.config.workerThreads = 'auto';
    vi.spyOn(os, 'cpus').mockReturnValue([{}]);
    await indexer.initializeWorkers();

    indexer.config.workerThreads = 2;
    await indexer.initializeWorkers();
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

  it('covers initializeWorkers error message branch (L132)', async () => {
    indexer.config.workerThreads = 2;
    workerMode = 'error';
    await indexer.initializeWorkers();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Worker initialization failed')
    );
  });

  it('covers processChunksWithWorkers message branches (L249, L254, L287)', async () => {
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

  it('covers processChunksWithWorkers failedChunks branch (L287 true)', async () => {
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

  it('covers processChunksWithWorkers L287 false branch', async () => {
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

  it('covers indexFile verbose=true failure (L417 block)', async () => {
    indexer.config.verbose = true;
    vi.spyOn(fs, 'stat').mockResolvedValue({ isDirectory: () => false, size: 100 });
    vi.spyOn(fs, 'readFile').mockResolvedValue('content');
    vi.spyOn(utils, 'hashContent').mockReturnValue('new-hash');
    mockCache.getFileHash.mockReturnValue('old-hash');

    vi.spyOn(utils, 'smartChunk').mockReturnValue([{ text: 'chunk1', startLine: 1, endLine: 2 }]);
    mockEmbedder.mockRejectedValue(new Error('fail'));

    await indexer.indexFile('file.js');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Skipped hash update'));
  });

  it('covers indexAll stats increment and hash update (L764)', async () => {
    indexer.config.verbose = false;
    indexer.config.batchSize = 1;

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

  it('covers batch hash skip log (L803) and ANN error log (L860)', async () => {
    indexer.config.verbose = true;
    indexer.config.batchSize = 1;
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
    await new Promise((resolve) => setImmediate(resolve));

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Skipped hash update'));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Background ANN build failed')
    );
  });

  it('covers indexAll verbose=true edge cases (L804, L861)', async () => {
    indexer.config.verbose = true;
    indexer.config.batchSize = 1;

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
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Skipped hash update'));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Background ANN build failed')
    );
  });

  it('covers indexAll progress branches (L813)', async () => {
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
});
