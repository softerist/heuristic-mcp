import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class MockServer {
    constructor() {
      this.capabilities = {};
      this.hybridSearch = null;
    }
    setRequestHandler() {}
    setNotificationHandler() {}
    connect() {
      return Promise.resolve();
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class MockTransport {},
}));

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue({}),
  env: {
    backends: {
      onnx: {
        numThreads: 1,
        wasm: { numThreads: 1 },
      },
    },
  },
}));

vi.mock('../features/lifecycle.js', () => ({
  stop: vi.fn(),
  start: vi.fn(),
  status: vi.fn(),
}));

const lifecycleMock = {
  registerSignalHandlers: vi.fn(),
  setupPidFile: vi.fn(),
  acquireWorkspaceLock: vi.fn(),
  releaseWorkspaceLock: vi.fn(),
  stopOtherHeuristicServers: vi.fn(),
};
vi.mock('../lib/server-lifecycle.js', () => lifecycleMock);

vi.mock('../lib/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    verbose: true,
    searchDirectory: '/mock/search',
    embeddingModel: 'mock-model',
    cacheDirectory: '/mock/cache',
    fileExtensions: ['js'],
    excludePatterns: [],
  }),
  getGlobalCacheDir: () => '/mock/global',
}));

vi.mock('../lib/cache.js', () => ({
  EmbeddingsCache: class MockCache {
    load() {
      return Promise.resolve();
    }
    save() {
      return Promise.resolve();
    }
    setVectorStore() {}
    fileHashes = new Map();
    getFileHashKeys() {
      return Array.from(this.fileHashes.keys());
    }
    clearFileHashes() {
      this.fileHashes.clear();
    }
    getFileHashCount() {
      return this.fileHashes.size;
    }
    clearCallGraphData() {}
    pruneCallGraphData() {}
    getVectorStore() {
      return [];
    }
    ensureAnnIndex() {
      return Promise.resolve();
    }
    consumeAutoReindex() {
      return false;
    }
    clearInMemoryState() {}
    getStoreSize() {
      return 0;
    }
  },
}));

vi.mock('../features/index-codebase.js', async () => {
  return {
    CodebaseIndexer: class MockIndexer {
      indexAll() {
        return Promise.resolve({});
      }
      setupFileWatcher() {}
      terminateWorkers() {
        return Promise.resolve();
      }
      watcher = { close: vi.fn() };
    },
    getToolDefinition: () => ({ name: 'mock_indexer' }),
    handleToolCall: () => {},
  };
});

vi.mock('../features/hybrid-search.js', () => ({
  HybridSearch: class {},
  getToolDefinition: () => ({ name: 'hs' }),
  handleToolCall: () => {},
}));

vi.mock('../features/clear-cache.js', () => ({
  CacheClearer: class {},
  getToolDefinition: () => ({ name: 'cc' }),
  handleToolCall: () => {},
}));

vi.mock('../features/find-similar-code.js', () => ({
  FindSimilarCode: class {},
  getToolDefinition: () => ({ name: 'fsc' }),
  handleToolCall: () => {},
}));

vi.mock('../features/ann-config.js', () => ({
  AnnConfigTool: class {},
  getToolDefinition: () => ({ name: 'ac' }),
  handleToolCall: () => {},
}));

vi.mock('../features/register.js', () => ({
  register: vi.fn(),
}));

vi.mock('fs/promises', async () => {
  return {
    default: {
      access: vi.fn().mockResolvedValue(),
      readFile: vi.fn().mockResolvedValue('{}'),
      stat: vi.fn().mockResolvedValue({ isDirectory: () => false }),
      constants: { F_OK: 0 },
    },
  };
});

vi.mock('process', async () => {
  const actual = await vi.importActual('process');
  return {
    ...actual,
    exit: vi.fn(),
    memoryUsage: vi.fn(),
  };
});

describe('Index.js Memory Logging', () => {
  const oldVitest = process.env.VITEST;
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.VITEST = 'true';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});

    // We can't mock process.exit globally easily if not using vitest environment options,

    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    lifecycleMock.registerSignalHandlers.mockReset();
    lifecycleMock.registerSignalHandlers.mockImplementation((requestShutdown) => {
      process.on('SIGINT', () => requestShutdown('SIGINT'));
      process.on('SIGTERM', () => requestShutdown('SIGTERM'));
    });
    lifecycleMock.setupPidFile.mockReset();
    lifecycleMock.setupPidFile.mockResolvedValue('/mock/cache/.heuristic-mcp.pid');
    lifecycleMock.acquireWorkspaceLock.mockReset();
    lifecycleMock.acquireWorkspaceLock.mockResolvedValue({ acquired: true, ownerPid: null });
    lifecycleMock.releaseWorkspaceLock.mockReset();
    lifecycleMock.releaseWorkspaceLock.mockResolvedValue(undefined);
    lifecycleMock.stopOtherHeuristicServers.mockReset();
    lifecycleMock.stopOtherHeuristicServers.mockResolvedValue({ killed: [], failed: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (oldVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = oldVitest;
    }
  });

  it('should log memory usage periodically during startup', async () => {
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 1024 * 1024 * 100,
      heapUsed: 1024 * 1024 * 50,
      heapTotal: 1024 * 1024 * 80,
      external: 0,
      arrayBuffers: 0,
    });

    process.argv = ['node', 'index.js'];

    const fsPromises = await import('fs/promises');
    let accessResolve;
    const accessPromise = new Promise((resolve) => {
      accessResolve = resolve;
    });
    fsPromises.default.access.mockReturnValueOnce(accessPromise);

    const { main } = await import('../index.js');
    const importPromise = main();

    let attempts = 0;
    let calls = [];
    while(attempts < 50) {
      await vi.advanceTimersByTimeAsync(100);
      calls = console.info.mock.calls
        .map((c) => c[0])
        .filter((msg) => msg && msg.includes('[Server] Memory (startup)'));
      if (calls.length > 0) break;
      attempts++;
    }
    if (calls.length === 0) throw new Error('Not reached yet');

    await vi.advanceTimersByTimeAsync(16000);
    accessResolve();
    await importPromise;

    const allCalls = console.info.mock.calls
      .map((c) => c[0])
      .filter((msg) => msg && msg.includes('[Server] Memory'));
    const startupCalls = allCalls.filter((msg) => msg.includes('Memory (startup)'));

    expect(allCalls.length).toBeGreaterThanOrEqual(2);
    expect(startupCalls.length).toBeGreaterThanOrEqual(2);
  });
});
