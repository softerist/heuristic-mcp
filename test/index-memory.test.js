
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mocks
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class MockServer {
    constructor() {
      this.capabilities = {};
      this.hybridSearch = null;
    }
    setRequestHandler() {}
    connect() {
      return Promise.resolve();
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class MockTransport {},
}));

vi.mock('@xenova/transformers', () => ({
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

// Mock config to ensure verbose is true
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

// Mock cache
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
  },
}));

// Mock features
vi.mock('../features/index-codebase.js', async () => {
    return {
        CodebaseIndexer: class MockIndexer {
            indexAll() { return Promise.resolve({}); }
            setupFileWatcher() {}
            terminateWorkers() { return Promise.resolve(); }
            watcher = { close: vi.fn() }
        },
        getToolDefinition: () => ({ name: 'mock_indexer' }),
        handleToolCall: () => {}
    };
});

vi.mock('../features/hybrid-search.js', () => ({
    HybridSearch: class {},
    getToolDefinition: () => ({ name: 'hs' }),
    handleToolCall: () => {}
}));

vi.mock('../features/clear-cache.js', () => ({
    CacheClearer: class {},
    getToolDefinition: () => ({ name: 'cc' }),
    handleToolCall: () => {}
}));

vi.mock('../features/find-similar-code.js', () => ({
     FindSimilarCode: class {},
    getToolDefinition: () => ({ name: 'fsc' }),
    handleToolCall: () => {}
}));

vi.mock('../features/ann-config.js', () => ({
    AnnConfigTool: class {},
    getToolDefinition: () => ({ name: 'ac' }),
    handleToolCall: () => {}
}));

vi.mock('../features/register.js', () => ({
    register: vi.fn()
}));

// Mock fs
vi.mock('fs/promises', async () => {
    return {
        default: {
            access: vi.fn().mockResolvedValue(),
            readFile: vi.fn().mockResolvedValue('{}'),
            stat: vi.fn().mockResolvedValue({ isDirectory: () => false }),
            constants: { F_OK: 0 }
        }
    }
});

vi.mock('process', async () => {
    const actual = await vi.importActual('process');
    return {
        ...actual,
        exit: vi.fn(),
        memoryUsage: vi.fn()
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
    // but we can spy on it.
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); });
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
    // Mock memoryUsage
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 1024 * 1024 * 100,
      heapUsed: 1024 * 1024 * 50,
      heapTotal: 1024 * 1024 * 80,
      external: 0,
      arrayBuffers: 0
    });

    // We must ensure arguments don't trigger immediate exit
    process.argv = ['node', 'index.js']; // clean args

    const fsPromises = await import('fs/promises');
    let accessResolve;
    const accessPromise = new Promise((resolve) => {
      accessResolve = resolve;
    });
    fsPromises.default.access.mockReturnValueOnce(accessPromise);

    // Import the module and call main
    const { main } = await import('../index.js');
    const importPromise = main();
    
    // Wait for the first memory log to ensure initialize has reached the interval setup
    await vi.waitFor(() => {
        const calls = console.info.mock.calls.map(c => c[0]).filter(msg => msg && msg.includes('[Server] Memory (startup)'));
        if (calls.length === 0) throw new Error('Not reached yet');
    }, { timeout: 1000, interval: 10 });
    
    // Advance time to trigger interval (15000ms)
    await vi.advanceTimersByTimeAsync(16000);
    accessResolve();
    await importPromise;

    // Check calls
    // It should be called immediately on startup
    // And then periodically
    const calls = console.info.mock.calls.map(c => c[0]).filter(msg => msg && msg.includes('[Server] Memory'));
    const startupCalls = calls.filter((msg) => msg.includes('Memory (startup)'));
    
    // Expect at least 2 calls (startup + interval)
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(startupCalls.length).toBeGreaterThanOrEqual(2);
    
    // We can't guarantee distinct messages if we mocked memoryUsage to static values, 
    // but we can verify the COUNT of calls.
  });
});
