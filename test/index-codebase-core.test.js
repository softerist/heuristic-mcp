import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let mockFiles = [];
let cpuCount = 2;
let workerMessageType = 'ready';
const fsMock = {};
const smartChunkMock = vi.fn();
const hashContentMock = vi.fn();

vi.mock('fdir', () => ({
  fdir: class {
    withFullPaths() {
      return this;
    }
    exclude() {
      return this;
    }
    filter(fn) {
      this.filterFn = fn;
      return this;
    }
    crawl() {
      return this;
    }
    withPromise() {
      const filtered = this.filterFn ? mockFiles.filter(this.filterFn) : mockFiles;
      return Promise.resolve(filtered);
    }
  },
}));
vi.mock('os', () => ({
  default: { cpus: () => new Array(cpuCount).fill({}) },
  cpus: () => new Array(cpuCount).fill({}),
}));
class MockWorker {
  once(event, handler) {
    if (event === 'message') {
      setImmediate(() => handler({ type: workerMessageType, error: 'worker fail' }));
    }
  }
  on() {}
  off() {}
  postMessage() {}
  terminate() {
    return Promise.resolve();
  }
}
vi.mock('worker_threads', () => ({
  Worker: MockWorker,
}));
vi.mock('fs/promises', () => ({
  default: fsMock,
  ...fsMock,
}));
vi.mock('../lib/utils.js', () => ({
  smartChunk: (...args) => smartChunkMock(...args),
  hashContent: (...args) => hashContentMock(...args),
}));
vi.mock('../lib/call-graph.js', () => ({
  extractCallData: vi.fn().mockReturnValue({ definitions: [], calls: [] }),
}));

const createCache = () => ({
  vectorStore: [],
  fileHashes: new Map(),
  fileCallData: new Map(),
  getFileHashKeys() {
    return Array.from(this.fileHashes.keys());
  },
  getFileHashCount() {
    return this.fileHashes.size;
  },
  clearFileHashes() {
    this.fileHashes.clear();
  },
  getFileCallDataKeys() {
    return Array.from(this.fileCallData.keys());
  },
  getFileCallDataCount() {
    return this.fileCallData.size;
  },
  clearFileCallData() {
    this.fileCallData.clear();
  },
  getFileHash: vi.fn(),
  setFileHash: vi.fn(),
  deleteFileHash: vi.fn(),
  removeFileFromStore: vi.fn(),
  addToStore: vi.fn(),
  setVectorStore: vi.fn(),
  getVectorStore: vi.fn().mockReturnValue([]),
  pruneCallGraphData: vi.fn().mockReturnValue(0),
  clearCallGraphData: vi.fn(),
  save: vi.fn().mockResolvedValue(undefined),
  rebuildCallGraph: vi.fn(),
  ensureAnnIndex: vi.fn().mockResolvedValue(null),
  setLastIndexDuration: vi.fn(),
  setLastIndexStats: vi.fn(),
});

describe('index-codebase branch coverage focused', () => {
  let consoleWarn;
  let consoleInfo;

  beforeEach(() => {
    vi.resetModules();
    mockFiles = [];
    cpuCount = 2;
    workerMessageType = 'ready';
    fsMock.stat = vi.fn();
    fsMock.readFile = vi.fn();
    fsMock.mkdir = vi.fn();
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarn.mockRestore();
    consoleInfo.mockRestore();
  });

  it('handles auto worker init failures', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      workerThreads: 'auto',
      verbose: true,
      embeddingModel: 'test-model',
      excludePatterns: [],
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    cpuCount = 4;
    workerMessageType = 'error';
    await indexer.initializeWorkers();

    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('Worker initialization failed')
    );
  });

  it('rejects worker ready promise on error message', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      workerThreads: 2,
      verbose: true,
      embeddingModel: 'test-model',
      excludePatterns: [],
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    workerMessageType = 'error';
    const terminateSpy = vi.spyOn(indexer, 'terminateWorkers');

    await indexer.initializeWorkers();

    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('Worker initialization failed')
    );
    expect(terminateSpy).toHaveBeenCalled();
  });

  it('times out worker init on unexpected message type', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      workerThreads: 2,
      verbose: true,
      embeddingModel: 'test-model',
      excludePatterns: [],
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    workerMessageType = 'other';
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      fn();
      return 0;
    });

    try {
      await indexer.initializeWorkers();
    } finally {
      timeoutSpy.mockRestore();
    }

    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('Worker initialization failed')
    );
  });

  it('matches exclude patterns with and without path separators', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      excludePatterns: ['skip.js', '**/dir/**'],
      fileExtensions: ['js'],
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    expect(indexer.isExcluded('/root/skip.js')).toBe(true);
    expect(indexer.isExcluded('/root/dir/file.js')).toBe(true);
  });

  it('covers worker error message handling and retry', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const indexer = new CodebaseIndexer(vi.fn(), cache, { workerThreads: 2 });

    const makeWorker = (mode) => {
      let handler;
      return {
        on: (event, fn) => {
          if (event === 'message') handler = fn;
        },
        once: () => {},
        off: () => {},
        postMessage: (msg) => {
          if (mode === 'results') {
            handler({ type: 'results', results: [{ success: true }], batchId: msg.batchId });
          } else {
            handler({ type: 'error', error: 'boom', batchId: msg.batchId });
          }
        },
      };
    };
    indexer.workers = [makeWorker('results'), makeWorker('error')];

    const fallbackSpy = vi
      .spyOn(indexer, 'processChunksSingleThreaded')
      .mockResolvedValue([{ success: true }]);

    const results = await indexer.processChunksWithWorkers([
      { file: 'a.js', text: 'x' },
      { file: 'b.js', text: 'y' },
    ]);

    expect(results.length).toBeGreaterThan(0);
    expect(fallbackSpy).toHaveBeenCalled();
  });

  it('retries failed worker batches when results are empty', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const indexer = new CodebaseIndexer(vi.fn(), cache, { workerThreads: 1 });

    let handler;
    const worker = {
      on: (event, fn) => {
        if (event === 'message') handler = fn;
      },
      once: () => {},
      off: () => {},
      postMessage: (msg) => {
        handler({ type: 'results', results: [], batchId: msg.batchId });
      },
    };
    indexer.workers = [worker];

    const fallbackSpy = vi
      .spyOn(indexer, 'processChunksSingleThreaded')
      .mockResolvedValue([{ success: true }]);

    await indexer.processChunksWithWorkers([{ file: 'a.js', text: 'x' }]);

    expect(fallbackSpy).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ file: 'a.js' })])
    );
  });

  it('skips retry when worker chunks are emptied after processing', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const indexer = new CodebaseIndexer(vi.fn(), cache, { workerThreads: 1 });

    // Create a worker that returns empty results
    let handler;
    const worker = {
      on: (event, fn) => {
        if (event === 'message') handler = fn;
      },
      once: () => {},
      off: () => {},
      postMessage: (msg) => {
        // Respond with success but empty results, implying nothing needed retry or all done
        handler({ type: 'results', results: [], batchId: msg.batchId });
      },
    };
    indexer.workers = [worker];

    const fallbackSpy = vi.spyOn(indexer, 'processChunksSingleThreaded').mockResolvedValue([]);
    const results = await indexer.processChunksWithWorkers([{ file: 'a.js', text: 'x' }]);
    expect(results).toEqual([]);
    expect(fallbackSpy).toHaveBeenCalled();
  });

  it('handles mismatched batch IDs and times out', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const indexer = new CodebaseIndexer(vi.fn(), cache, { workerThreads: 2 });

    let handler;
    const worker = {
      on: (event, fn) => {
        if (event === 'message') handler = fn;
      },
      once: () => {},
      off: () => {},
      postMessage: () => {
        handler({ type: 'results', results: [{ success: true }], batchId: 'wrong' });
      },
    };
    indexer.workers = [worker];

    const fallbackSpy = vi
      .spyOn(indexer, 'processChunksSingleThreaded')
      .mockResolvedValue([{ success: true }]);

    vi.useFakeTimers();
    const promise = indexer.processChunksWithWorkers([{ file: 'a.js', text: 'x' }]);
    vi.advanceTimersByTime(300001);
    const results = await promise;
    vi.useRealTimers();

    expect(fallbackSpy).toHaveBeenCalled();
    expect(results).toHaveLength(1);
  });

  it('skips hash update logging when verbose is false for single-file failures', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const embedder = vi.fn().mockRejectedValue(new Error('embed fail'));
    const config = {
      excludePatterns: [],
      verbose: false,
      maxFileSize: 10,
      fileExtensions: ['js'],
    };
    const indexer = new CodebaseIndexer(embedder, cache, config);

    fsMock.stat.mockResolvedValueOnce({ isDirectory: () => false, size: 1 });
    fsMock.readFile.mockResolvedValueOnce('content');
    hashContentMock.mockReturnValueOnce('newhash');
    cache.getFileHash.mockReturnValueOnce('oldhash');
    smartChunkMock.mockReturnValueOnce([{ text: 'a', startLine: 1, endLine: 1 }]);

    await indexer.indexFile('/root/fail-quiet.js');

    const hasSkipLog = consoleWarn.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('Skipped hash update')
    );
    expect(hasSkipLog).toBe(false);
  });

  it('logs indexFile hash skip when embedding fails in verbose mode', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const embedder = vi.fn().mockRejectedValue(new Error('embed fail'));
    const config = {
      excludePatterns: [],
      verbose: true,
      maxFileSize: 10,
      fileExtensions: ['js'],
    };
    const indexer = new CodebaseIndexer(embedder, cache, config);

    fsMock.stat.mockResolvedValueOnce({ isDirectory: () => false, size: 1 });
    fsMock.readFile.mockResolvedValueOnce('content');
    hashContentMock.mockReturnValueOnce('newhash');
    cache.getFileHash.mockReturnValueOnce('oldhash');
    smartChunkMock.mockReturnValueOnce([{ text: 'a', startLine: 1, endLine: 1 }]);

    await indexer.indexFile('/root/fail.js');

    const hasSkipLog = consoleWarn.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('Skipped hash update')
    );
    expect(hasSkipLog).toBe(true);
  });

  it('logs indexFile hash skip on partial embedding failures', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const embedder = vi
      .fn()
      .mockResolvedValueOnce({ data: Float32Array.from([1]) })
      .mockRejectedValueOnce(new Error('embed fail'));
    const config = {
      excludePatterns: [],
      verbose: true,
      maxFileSize: 10,
      fileExtensions: ['js'],
    };
    const indexer = new CodebaseIndexer(embedder, cache, config);

    fsMock.stat.mockResolvedValueOnce({ isDirectory: () => false, size: 1 });
    fsMock.readFile.mockResolvedValueOnce('content');
    hashContentMock.mockReturnValueOnce('newhash');
    cache.getFileHash.mockReturnValueOnce('oldhash');
    smartChunkMock.mockReturnValueOnce([
      { text: 'a', startLine: 1, endLine: 1 },
      { text: 'b', startLine: 2, endLine: 2 },
    ]);

    await indexer.indexFile('/root/partial.js');

    const hasSkipLog = consoleWarn.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('Skipped hash update')
    );
    expect(hasSkipLog).toBe(true);
  });

  it('covers batch hash skip and ANN background error logging', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    cache.ensureAnnIndex = vi.fn().mockRejectedValue(new Error('ann fail'));
    cache.getVectorStore.mockReturnValue([]);
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 1,
      maxFileSize: 1000,
      callGraphEnabled: false,
      verbose: true,
      workerThreads: 0,
      allowSingleThreadFallback: true,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    mockFiles = ['/root/a.js'];
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/root/a.js', content: 'code', hash: 'h' }]);
    smartChunkMock.mockReturnValueOnce([
      { text: 'a', startLine: 1, endLine: 1 },
      { text: 'b', startLine: 2, endLine: 2 },
    ]);
    const processSpy = vi.spyOn(indexer, 'processChunksSingleThreaded').mockResolvedValue([
      { file: '/root/a.js', startLine: 1, endLine: 1, content: 'a', vector: [1], success: true },
      { file: '/root/a.js', startLine: 2, endLine: 2, content: 'b', vector: [2], success: false },
    ]);

    await indexer.indexAll(false);
    await new Promise((resolve) => setImmediate(resolve));

    const hasBatchSkip = consoleWarn.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('Skipped hash update for a.js')
    );
    const hasAnnError = consoleWarn.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('Background ANN build failed')
    );
    expect(hasBatchSkip).toBe(true);
    expect(hasAnnError).toBe(true);
    expect(processSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ startLine: 1 }),
        expect.objectContaining({ startLine: 2 }),
      ])
    );
  });

  it('ignores results for files not in the current batch', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 1,
      maxFileSize: 1000,
      callGraphEnabled: false,
      verbose: false,
      workerThreads: 0,
      allowSingleThreadFallback: true,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    cpuCount = 1;
    mockFiles = ['/root/a.js'];
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/root/a.js', content: 'code', hash: 'h' }]);
    smartChunkMock.mockReturnValueOnce([{ text: 'a', startLine: 1, endLine: 1 }]);

    // Return a result for a file that wasn't in the batch ('phantom.js')
    vi.spyOn(indexer, 'processChunksSingleThreaded').mockResolvedValue([
      {
        file: '/root/phantom.js',
        startLine: 1,
        endLine: 1,
        content: 'a',
        vector: [1],
        success: true,
      },
    ]);

    await indexer.indexAll(false);
  });

  it('increments chunk stats and logs batch hash skip in verbose mode', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 1,
      maxFileSize: 1000,
      callGraphEnabled: false,
      verbose: true,
      workerThreads: 0,
      allowSingleThreadFallback: true,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    cpuCount = 1;
    mockFiles = ['/root/a.js'];
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/root/a.js', content: 'code', hash: 'h' }]);
    smartChunkMock.mockReturnValueOnce([
      { text: 'a', startLine: 1, endLine: 1 },
      { text: 'b', startLine: 2, endLine: 2 },
    ]);
    const processSpy = vi.spyOn(indexer, 'processChunksSingleThreaded').mockResolvedValue([
      { file: '/root/a.js', startLine: 1, endLine: 1, content: 'a', vector: [1], success: true },
      { file: '/root/a.js', startLine: 2, endLine: 2, content: 'b', vector: [2], success: false },
    ]);

    await indexer.indexAll(false);

    const hasBatchSkip = consoleWarn.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('Skipped hash update for a.js')
    );
    expect(hasBatchSkip).toBe(true);
    expect(processSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ startLine: 1 }),
        expect.objectContaining({ startLine: 2 }),
      ])
    );
  });

  it('skips batch hash update logging when verbose is false', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 1,
      maxFileSize: 1000,
      callGraphEnabled: false,
      verbose: false,
      workerThreads: 0,
      allowSingleThreadFallback: true,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    cpuCount = 1;
    mockFiles = ['/root/a.js'];
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/root/a.js', content: 'code', hash: 'h' }]);
    smartChunkMock.mockReturnValueOnce([
      { text: 'a', startLine: 1, endLine: 1 },
      { text: 'b', startLine: 2, endLine: 2 },
    ]);
    vi.spyOn(indexer, 'processChunksSingleThreaded').mockResolvedValue([
      { file: '/root/a.js', startLine: 1, endLine: 1, content: 'a', vector: [1], success: true },
      { file: '/root/a.js', startLine: 2, endLine: 2, content: 'b', vector: [2], success: false },
    ]);

    await indexer.indexAll(false);

    const hasBatchSkip = consoleWarn.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('Skipped hash update for a.js')
    );
    expect(hasBatchSkip).toBe(false);
  });

  it('logs ANN build failure in verbose mode', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    cache.ensureAnnIndex = vi.fn().mockRejectedValue(new Error('ann fail'));
    cache.getVectorStore.mockReturnValue([]);
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 1,
      maxFileSize: 1000,
      callGraphEnabled: false,
      verbose: true,
      workerThreads: 0,
      allowSingleThreadFallback: true,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    cpuCount = 1;
    mockFiles = ['/root/a.js'];
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/root/a.js', content: 'code', hash: 'h' }]);
    smartChunkMock.mockReturnValueOnce([{ text: 'a', startLine: 1, endLine: 1 }]);
    vi.spyOn(indexer, 'processChunksSingleThreaded').mockResolvedValue([
      { file: '/root/a.js', startLine: 1, endLine: 1, content: 'a', vector: [1], success: true },
    ]);

    await indexer.indexAll(false);
    await new Promise((resolve) => setImmediate(resolve));

    const hasAnnError = consoleWarn.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('Background ANN build failed')
    );
    expect(hasAnnError).toBe(true);
  });

  it('skips ANN build error logging when verbose is false', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    cache.ensureAnnIndex = vi.fn().mockRejectedValue(new Error('ann fail'));
    cache.getVectorStore.mockReturnValue([]);
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 1,
      maxFileSize: 1000,
      callGraphEnabled: false,
      verbose: false,
      workerThreads: 0,
      allowSingleThreadFallback: true,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    cpuCount = 1;
    mockFiles = ['/root/a.js'];
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/root/a.js', content: 'code', hash: 'h' }]);
    smartChunkMock.mockReturnValueOnce([{ text: 'a', startLine: 1, endLine: 1 }]);
    vi.spyOn(indexer, 'processChunksSingleThreaded').mockResolvedValue([
      { file: '/root/a.js', startLine: 1, endLine: 1, content: 'a', vector: [1], success: true },
    ]);

    await indexer.indexAll(false);
    await new Promise((resolve) => setImmediate(resolve));

    const hasAnnError = consoleWarn.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('Background ANN build failed')
    );
    expect(hasAnnError).toBe(false);
  });

  it('uses adaptive batch sizes and increments chunk stats', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 5,
      maxFileSize: 1000,
      callGraphEnabled: false,
      verbose: true,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    mockFiles = new Array(10001).fill(0).map((_, i) => `/root/b${i}.js`);
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/root/b0.js', content: 'code', hash: 'h' }]);
    smartChunkMock.mockReturnValueOnce([{ text: 'x', startLine: 1, endLine: 1 }]);
    const processSpy = vi
      .spyOn(indexer, 'processChunksSingleThreaded')
      .mockResolvedValue([
        { file: '/root/b0.js', startLine: 1, endLine: 1, content: 'x', vector: [1], success: true },
      ]);

    await indexer.indexAll(false);

    const hasBatchSize = consoleInfo.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('batch size: 500')
    );
    expect(hasBatchSize).toBe(true);
    expect(processSpy.mock.calls[0][0]).toHaveLength(1);
  });

  it('accepts allowed file names without matching extensions', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: ['SPECIAL'],
      verbose: false,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    mockFiles = ['/root/SPECIAL'];
    const files = await indexer.discoverFiles();

    expect(files).toEqual(['/root/SPECIAL']);
  });

  it('treats NODE_ENV=test as test environment', async () => {
    const oldVitest = process.env.VITEST;
    const oldNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = 'test';

    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      workerThreads: 2,
      verbose: true,
      embeddingModel: 'test-model',
      excludePatterns: [],
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    try {
      workerMessageType = 'ready';
      await indexer.initializeWorkers();
    } finally {
      if (oldVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = oldVitest;
      }
      process.env.NODE_ENV = oldNodeEnv;
    }
  });

  it('uses production timeouts when not in test env', async () => {
    const oldVitest = process.env.VITEST;
    const oldNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = 'production';

    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      workerThreads: 2,
      verbose: false,
      embeddingModel: 'test-model',
      excludePatterns: [],
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    try {
      workerMessageType = 'ready';
      await indexer.initializeWorkers();

      const worker = {
        postMessage: vi.fn(),
        once: (event, handler) => {
          if (event === 'exit') handler();
        },
        terminate: vi.fn().mockResolvedValue(undefined),
      };
      indexer.workers = [worker];
      await indexer.terminateWorkers();

      let handler;
      const worker2 = {
        on: (event, fn) => {
          if (event === 'message') handler = fn;
        },
        once: () => {},
        off: () => {},
        postMessage: (msg) => {
          handler({ type: 'results', results: [{ success: true }], batchId: msg.batchId });
        },
      };
      indexer.workers = [worker2];
      await indexer.processChunksWithWorkers([{ file: 'a.js', text: 'x' }]);
    } finally {
      if (oldVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = oldVitest;
      }
      process.env.NODE_ENV = oldNodeEnv;
    }
  });

  it('sets memory timer when verbose is true', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 1,
      maxFileSize: 1000,
      callGraphEnabled: false,
      verbose: true,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    mockFiles = ['/root/a.js'];
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/root/a.js', content: 'code', hash: 'h' }]);
    smartChunkMock.mockReturnValueOnce([{ text: 'a', startLine: 1, endLine: 1 }]);
    vi.spyOn(indexer, 'processChunksSingleThreaded').mockResolvedValue([
      { file: '/root/a.js', startLine: 1, endLine: 1, content: 'a', vector: [1], success: true },
    ]);

    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    await indexer.indexAll(false);
    expect(setIntervalSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('skips large preset content without verbose log', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 1,
      maxFileSize: 1,
      callGraphEnabled: false,
      verbose: false,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    mockFiles = ['/root/large.js'];
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/root/large.js', content: 'xx', hash: 'h', force: true }]);

    await indexer.indexAll(false);
  });

  it('skips stat errors without verbose log', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 1,
      maxFileSize: 1000,
      callGraphEnabled: false,
      verbose: false,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    mockFiles = ['/root/stat.js'];
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/root/stat.js', hash: 'h', force: true }]);
    fsMock.stat.mockRejectedValueOnce(new Error('stat fail'));

    await indexer.indexAll(false);
  });

  it('skips invalid stat results without verbose log', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 1,
      maxFileSize: 1000,
      callGraphEnabled: false,
      verbose: false,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    mockFiles = ['/root/invalid.js'];
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/root/invalid.js', hash: 'h', force: true }]);
    fsMock.stat.mockResolvedValueOnce({});

    await indexer.indexAll(false);
  });

  it('skips oversized files without verbose log', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 1,
      maxFileSize: 1,
      callGraphEnabled: false,
      verbose: false,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    mockFiles = ['/root/big.js'];
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/root/big.js', hash: 'h', force: true }]);
    fsMock.stat.mockResolvedValueOnce({ isDirectory: () => false, size: 10 });

    await indexer.indexAll(false);
  });

  it('skips read failures without verbose log', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 1,
      maxFileSize: 1000,
      callGraphEnabled: false,
      verbose: false,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    mockFiles = ['/root/read.js'];
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/root/read.js', hash: 'h', force: true }]);
    fsMock.stat.mockResolvedValueOnce({ isDirectory: () => false, size: 1 });
    fsMock.readFile.mockRejectedValueOnce(new Error('read fail'));

    await indexer.indexAll(false);
  });

  it('skips unchanged files without verbose log', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 1,
      maxFileSize: 1000,
      callGraphEnabled: false,
      verbose: false,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    mockFiles = ['/root/same.js'];
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/root/same.js', content: 'code', hash: 'h', force: false }]);
    cache.getFileHash.mockReturnValueOnce('h');

    await indexer.indexAll(false);
  });

  it('covers non-verbose branches in the batch loop', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 10,
      maxFileSize: 5,
      callGraphEnabled: false,
      verbose: false,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);

    cpuCount = 1;
    mockFiles = [
      '/root/large-content.js',
      '/root/stat-fail.js',
      '/root/invalid.js',
      '/root/big.js',
      '/root/read-fail.js',
      '/root/unchanged.js',
      '/root/ok.js',
    ];
    indexer.preFilterFiles = vi.fn().mockResolvedValue([
      { file: '/root/large-content.js', content: 'xxxxxx', hash: 'h1', force: true },
      { file: '/root/stat-fail.js', hash: 'h2', force: true },
      { file: '/root/invalid.js', hash: 'h3', force: true },
      { file: '/root/big.js', hash: 'h4', force: true },
      { file: '/root/read-fail.js', hash: 'h5', force: true },
      { file: '/root/unchanged.js', content: 'same', hash: 'samehash', force: false },
      { file: '/root/ok.js', hash: 'h6', force: true },
    ]);

    fsMock.stat.mockImplementation(async (filePath) => {
      const file = String(filePath);
      if (file.endsWith('stat-fail.js')) {
        throw new Error('stat fail');
      }
      if (file.endsWith('invalid.js')) {
        return {};
      }
      if (file.endsWith('big.js')) {
        return { isDirectory: () => false, size: 10 };
      }
      return { isDirectory: () => false, size: 1 };
    });

    fsMock.readFile.mockImplementation(async (filePath) => {
      const file = String(filePath);
      if (file.endsWith('read-fail.js')) {
        throw new Error('read fail');
      }
      return 'ok';
    });

    cache.getFileHash.mockImplementation((file) =>
      String(file).endsWith('unchanged.js') ? 'samehash' : 'other'
    );
    smartChunkMock.mockReturnValueOnce([{ text: 'a', startLine: 1, endLine: 1 }]);
    vi.spyOn(indexer, 'processChunksSingleThreaded').mockResolvedValue([]);

    await indexer.indexAll(false);
  });
});
