import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let lastIndexer = null;
let lastCache = null;
let lastServer = null;
let indexAllMock;
let setupFileWatcherMock;
let hybridHandleToolCall;
let indexHandleToolCall;
let clearHandleToolCall;
let findHandleToolCall;
let annHandleToolCall;
let callSchema;
let listSchema;

const configMock = {
  loadConfig: vi.fn(),
  getGlobalCacheDir: vi.fn(),
};
const fsMock = {
  access: vi.fn(),
};
const pipelineMock = vi.fn();
const registerMock = vi.fn();
const stopMock = vi.fn();
const startMock = vi.fn();
const statusMock = vi.fn();

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    constructor() {
      this.handlers = new Map();
      lastServer = this;
    }
    setRequestHandler(schema, handler) {
      this.handlers.set(schema, handler);
    }
    async connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));
vi.mock('@modelcontextprotocol/sdk/types.js', () => {
  callSchema = Symbol('call');
  listSchema = Symbol('list');
  return {
    CallToolRequestSchema: callSchema,
    ListToolsRequestSchema: listSchema,
  };
});
vi.mock('@xenova/transformers', () => ({
  pipeline: (...args) => pipelineMock(...args),
}));
vi.mock('fs/promises', () => fsMock);
vi.mock('../lib/config.js', () => configMock);
vi.mock('../lib/cache.js', () => ({
  EmbeddingsCache: class {
    constructor(config) {
      this.config = config;
      this.load = vi.fn().mockResolvedValue(undefined);
      this.save = vi.fn().mockResolvedValue(undefined);
      lastCache = this;
    }
  },
}));
vi.mock('../features/index-codebase.js', () => ({
  CodebaseIndexer: class {
    constructor() {
      this.watcher = { close: vi.fn().mockResolvedValue(undefined) };
      this.terminateWorkers = vi.fn().mockResolvedValue(undefined);
      this.indexAll = indexAllMock;
      this.setupFileWatcher = setupFileWatcherMock;
      lastIndexer = this;
    }
  },
  getToolDefinition: vi.fn(() => ({ name: 'index-codebase' })),
  handleToolCall: (...args) => indexHandleToolCall(...args),
}));
vi.mock('../features/hybrid-search.js', () => ({
  HybridSearch: class {},
  getToolDefinition: vi.fn(() => ({ name: 'semantic_search' })),
  handleToolCall: (...args) => hybridHandleToolCall(...args),
}));
vi.mock('../features/clear-cache.js', () => ({
  CacheClearer: class {},
  getToolDefinition: vi.fn(() => ({ name: 'clear_cache' })),
  handleToolCall: (...args) => clearHandleToolCall(...args),
}));
vi.mock('../features/find-similar-code.js', () => ({
  FindSimilarCode: class {},
  getToolDefinition: vi.fn(() => ({ name: 'find_similar_code' })),
  handleToolCall: (...args) => findHandleToolCall(...args),
}));
vi.mock('../features/ann-config.js', () => ({
  AnnConfigTool: class {},
  getToolDefinition: vi.fn(() => ({ name: 'ann_config' })),
  handleToolCall: (...args) => annHandleToolCall(...args),
}));
vi.mock('../features/register.js', () => ({
  register: (...args) => registerMock(...args),
}));
vi.mock('../features/lifecycle.js', () => ({
  stop: (...args) => stopMock(...args),
  start: (...args) => startMock(...args),
  status: (...args) => statusMock(...args),
}));

const baseConfig = {
  searchDirectory: 'C:\\work',
  embeddingModel: 'test-model',
  cacheDirectory: 'C:\\cache',
  watchFiles: false,
};

describe('index.js CLI coverage', () => {
  let originalArgv;
  let onSpy;
  let exitSpy;
  let errorSpy;
  let listeners;

  beforeEach(() => {
    vi.resetModules();
    originalArgv = process.argv;
    listeners = {};
    lastIndexer = null;
    lastCache = null;
    lastServer = null;
    indexAllMock = vi.fn().mockResolvedValue(undefined);
    setupFileWatcherMock = vi.fn();
    hybridHandleToolCall = vi.fn();
    indexHandleToolCall = vi.fn();
    clearHandleToolCall = vi.fn();
    findHandleToolCall = vi.fn();
    annHandleToolCall = vi.fn();
    registerMock.mockReset();
    stopMock.mockReset();
    startMock.mockReset();
    statusMock.mockReset();
    pipelineMock.mockReset();
    configMock.loadConfig.mockReset();
    configMock.getGlobalCacheDir.mockReset();
    fsMock.access.mockReset();
    onSpy = vi.spyOn(process, 'on').mockImplementation((event, handler) => {
      listeners[event] = handler;
      return process;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    onSpy.mockRestore();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it('registers with filter and exits', async () => {
    process.argv = ['node', 'index.js', '--register', 'antigravity'];
    registerMock.mockResolvedValue(undefined);
    const exitError = new Error('exit');
    exitSpy.mockImplementation(() => {
      throw exitError;
    });

    try {
      await import('../index.js');
    } catch (err) {
      expect(err).toBe(exitError);
    }

    expect(registerMock).toHaveBeenCalledWith('antigravity');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('registers without filter when argument is missing', async () => {
    process.argv = ['node', 'index.js', '--register'];
    registerMock.mockResolvedValue(undefined);
    const exitError = new Error('exit');
    exitSpy.mockImplementation(() => {
      throw exitError;
    });

    try {
      await import('../index.js');
    } catch (err) {
      expect(err).toBe(exitError);
    }

    expect(registerMock).toHaveBeenCalledWith(null);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prints version and exits', async () => {
    process.argv = ['node', 'index.js', '--version'];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitError = new Error('exit');
    exitSpy.mockImplementation(() => {
      throw exitError;
    });

    try {
      await import('../index.js');
    } catch (err) {
      expect(err).toBe(exitError);
    }

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/\d+\.\d+\.\d+/));
    expect(exitSpy).toHaveBeenCalledWith(0);
    logSpy.mockRestore();
  });

  it('enables logs flag and strips args', async () => {
    process.argv = ['node', 'index.js', '--logs'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await import('../index.js');

    const called = logSpy.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('Starting server with verbose')
    );
    expect(process.env.SMART_CODING_VERBOSE).toBe('true');
    expect(called).toBe(true);
    logSpy.mockRestore();
  });

  it('handles lifecycle stop/start/status flags', async () => {
    const exitError = new Error('exit');
    exitSpy.mockImplementation(() => {
      throw exitError;
    });

    process.argv = ['node', 'index.js', '--stop'];
    stopMock.mockResolvedValue(undefined);
    try {
      await import('../index.js');
    } catch { /* ignore */ }
    expect(stopMock).toHaveBeenCalled();

    vi.resetModules();
    process.argv = ['node', 'index.js', '--start'];
    startMock.mockResolvedValue(undefined);
    try {
      await import('../index.js');
    } catch { /* ignore */ }
    expect(startMock).toHaveBeenCalled();

    vi.resetModules();
    process.argv = ['node', 'index.js', '--status'];
    statusMock.mockResolvedValue(undefined);
    try {
      await import('../index.js');
    } catch { /* ignore */ }
    expect(statusMock).toHaveBeenCalled();
  });

  it('falls back when workspace variables are unexpanded', async () => {
    process.argv = ['node', 'index.js', '--workspace', '${workspaceFolder}'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));

    await import('../index.js');

    const errors = errorSpy.mock.calls.map((call) => call[0]);
    const hasFallback = errors.some(
      (message) => typeof message === 'string' && message.includes('IDE variable not expanded')
    );
    expect(hasFallback).toBe(true);
  });

  it('parses workspace args with equals and starts watcher', async () => {
    process.argv = ['node', 'index.js', '--workspace=C:\\work'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue({
      ...baseConfig,
      watchFiles: true,
    });
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));

    await import('../index.js');

    expect(setupFileWatcherMock).toHaveBeenCalled();
  });

  it('ignores workspace flag without a value', async () => {
    process.argv = ['node', 'index.js', '--workspace'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));

    await import('../index.js');

    const errors = errorSpy.mock.calls.map((call) => call[0]);
    const hasWorkspace = errors.some(
      (message) => typeof message === 'string' && message.includes('Workspace mode')
    );
    expect(hasWorkspace).toBe(false);
  });

  it('logs background indexing errors', async () => {
    process.argv = ['node', 'index.js', '--workspace', 'C:\\work'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));
    indexAllMock.mockRejectedValue(new Error('index fail'));

    await import('../index.js');

    const errors = errorSpy.mock.calls.map((call) => call[0]);
    const hasError = errors.some(
      (message) => typeof message === 'string' && message.includes('Background indexing error:')
    );
    expect(hasError).toBe(true);
  });

  it('parses workspace args and handles shutdown cleanup', async () => {
    process.argv = ['node', 'index.js', '--workspace', 'C:\\work'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));

    await import('../index.js');

    const errors = errorSpy.mock.calls.map((call) => call[0]);
    const hasWorkspace = errors.some(
      (message) => typeof message === 'string' && message.includes('Workspace mode')
    );
    expect(hasWorkspace).toBe(true);
    expect(lastIndexer).toBeTruthy();
    expect(lastCache).toBeTruthy();

    lastIndexer.terminateWorkers
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('sigint-fail'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('sigterm-fail'));

    vi.useFakeTimers();
    const runHandler = async (handler) => {
      const promise = handler();
      await vi.runAllTimersAsync();
      await promise;
    };

    await runHandler(listeners.SIGINT);
    await runHandler(listeners.SIGINT);
    await runHandler(listeners.SIGTERM);
    await runHandler(listeners.SIGTERM);

    expect(lastIndexer.watcher.close).toHaveBeenCalled();
    expect(lastCache.save).toHaveBeenCalled();
  });

  it('handles shutdown when no watcher, workers, or cache exist', async () => {
    process.argv = ['node', 'index.js', '--workspace', 'C:\\work'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));

    await import('../index.js');

    lastIndexer.watcher = null;
    lastIndexer.terminateWorkers = null;
    lastCache = null;

    await listeners.SIGINT();
    await listeners.SIGTERM();

    const errors = errorSpy.mock.calls.map((call) => call[0]);
    const hasShutdown = errors.some(
      (message) => typeof message === 'string' && message.includes('Shutting down')
    );
    expect(hasShutdown).toBe(true);
  });

  it('lists tools and routes tool calls', async () => {
    process.argv = ['node', 'index.js', '--workspace', 'C:\\work'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));

    await import('../index.js');

    const listHandler = lastServer.handlers.get(listSchema);
    const callHandler = lastServer.handlers.get(callSchema);

    const listResponse = await listHandler();
    expect(listResponse.tools).toHaveLength(5);

    hybridHandleToolCall.mockResolvedValue({ ok: true });
    const callResponse = await callHandler({
      params: { name: 'semantic_search' },
    });
    expect(hybridHandleToolCall).toHaveBeenCalled();
    expect(callResponse).toEqual({ ok: true });

    const unknown = await callHandler({ params: { name: 'unknown_tool' } });
    expect(unknown.content[0].text).toContain('Unknown tool');
  });

  it('handles shutdown when cache is not yet initialized', async () => {
    configMock.loadConfig.mockRejectedValue(new Error('pre-cache fail'));

    try {
      await import('../index.js');
    } catch (err) {
      // Expected failure
    }

    await listeners.SIGINT();
    await listeners.SIGTERM();

    const errors = errorSpy.mock.calls.map((call) => call[0]);
    const hasCacheSaved = errors.some(
      (message) => typeof message === 'string' && message.includes('Cache saved')
    );
    expect(hasCacheSaved).toBe(false);
  });
});
