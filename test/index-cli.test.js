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
let logsMock;
const lifecycleMock = {
  registerSignalHandlers: vi.fn(),
  setupPidFile: vi.fn(),
  acquireWorkspaceLock: vi.fn(),
  stopOtherHeuristicServers: vi.fn(),
};

const configMock = {
  loadConfig: vi.fn(),
  getGlobalCacheDir: vi.fn(),
};
const fsMock = {
  access: vi.fn(),
  rm: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
};
const loggingMock = {
  enableStderrOnlyLogging: vi.fn(),
  setupFileLogging: vi.fn(),
  getLogFilePath: vi.fn(() => 'C:\\cache\\logs\\server.log'),
  flushLogs: vi.fn().mockResolvedValue(undefined),
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
      this.notificationHandlers = new Map();
      lastServer = this;
    }
    setRequestHandler(schema, handler) {
      this.handlers.set(schema, handler);
    }
    setNotificationHandler(schema, handler) {
      this.notificationHandlers.set(schema, handler);
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
  const listResourcesSchema = Symbol('listResources');
  const readResourceSchema = Symbol('readResource');
  const RootsListChangedNotificationSchema = Symbol('rootsListChanged');
  
  return {
    RootsListChangedNotificationSchema,
    CallToolRequestSchema: callSchema,
    ListToolsRequestSchema: listSchema,
    ListResourcesRequestSchema: listResourcesSchema,
    ReadResourceRequestSchema: readResourceSchema,
  };
});
vi.mock('@huggingface/transformers', () => ({
  pipeline: (...args) => pipelineMock(...args),
  env: {
    backends: {
      onnx: {
        numThreads: 1,
        wasm: { numThreads: 1 },
      },
    },
  },
}));
vi.mock('fs/promises', () => ({ default: fsMock, ...fsMock }));
vi.mock('../lib/logging.js', () => loggingMock);
vi.mock('../lib/config.js', () => configMock);
vi.mock('../lib/server-lifecycle.js', () => lifecycleMock);
vi.mock('../lib/cache.js', () => ({
  EmbeddingsCache: class {
    constructor(config) {
      this.config = config;
      this.load = vi.fn().mockResolvedValue(undefined);
      this.save = vi.fn().mockResolvedValue(undefined);
      this.consumeAutoReindex = vi.fn().mockReturnValue(false);
      this.clearInMemoryState = vi.fn();
      this.getStoreSize = vi.fn().mockReturnValue(0);
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
  logs: (...args) => logsMock(...args),
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
  let infoSpy;
  let warnSpy;
  let listeners;
  let originalVerboseEnv;
  let originalLogsEnv;

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    originalArgv = process.argv;
    originalVerboseEnv = process.env.SMART_CODING_VERBOSE;
    originalLogsEnv = process.env.SMART_CODING_LOGS;
    listeners = {
      SIGINT: () => {},
      SIGTERM: () => {},
    };
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
    logsMock = vi.fn();
    registerMock.mockReset();
    stopMock.mockReset();
    startMock.mockReset();
    statusMock.mockReset();
    pipelineMock.mockReset();
    configMock.loadConfig.mockReset();
    configMock.getGlobalCacheDir.mockReset();
    fsMock.access.mockReset();
    fsMock.readFile.mockReset();
    fsMock.rm.mockReset();
    fsMock.readdir.mockReset();
    loggingMock.flushLogs.mockReset();
    loggingMock.flushLogs.mockResolvedValue(undefined);
    loggingMock.getLogFilePath.mockReset();
    loggingMock.getLogFilePath.mockReturnValue('C:\\cache\\logs\\server.log');
    lifecycleMock.registerSignalHandlers.mockReset();
    lifecycleMock.registerSignalHandlers.mockImplementation((requestShutdown) => {
      process.on('SIGINT', () => requestShutdown('SIGINT'));
      process.on('SIGTERM', () => requestShutdown('SIGTERM'));
    });
    lifecycleMock.setupPidFile.mockReset();
    lifecycleMock.setupPidFile.mockResolvedValue('C:\\cache\\.heuristic-mcp.pid');
    lifecycleMock.acquireWorkspaceLock.mockReset();
    lifecycleMock.acquireWorkspaceLock.mockResolvedValue({ acquired: true, ownerPid: null });
    lifecycleMock.stopOtherHeuristicServers.mockReset();
    lifecycleMock.stopOtherHeuristicServers.mockResolvedValue({ killed: [], failed: [] });
    onSpy = vi.spyOn(process, 'on').mockImplementation((event, handler) => {
      listeners[event] = handler;
      return process;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalVerboseEnv === undefined) {
      delete process.env.SMART_CODING_VERBOSE;
    } else {
      process.env.SMART_CODING_VERBOSE = originalVerboseEnv;
    }
    if (originalLogsEnv === undefined) {
      delete process.env.SMART_CODING_LOGS;
    } else {
      process.env.SMART_CODING_LOGS = originalLogsEnv;
    }
    onSpy.mockRestore();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('starts with filter and exits', async () => {
    process.argv = ['node', 'index.js', '--start', 'antigravity'];
    startMock.mockResolvedValue(undefined);
    const exitError = new Error('exit');
    exitSpy.mockImplementation(() => {
      throw exitError;
    });

    try {
      const { main } = await import('../index.js');
      await main();
    } catch (err) {
      expect(err).toBe(exitError);
    }

    expect(startMock).toHaveBeenCalledWith('antigravity');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('starts without filter when argument is missing', async () => {
    process.argv = ['node', 'index.js', '--start'];
    startMock.mockResolvedValue(undefined);
    const exitError = new Error('exit');
    exitSpy.mockImplementation(() => {
      throw exitError;
    });

    try {
      const { main } = await import('../index.js');
      await main();
    } catch (err) {
      expect(err).toBe(exitError);
    }

    expect(startMock).toHaveBeenCalledWith(null);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prints version and exits', async () => {
    process.argv = ['node', 'index.js', '--version'];
    const exitError = new Error('exit');
    exitSpy.mockImplementation(() => {
      throw exitError;
    });

    try {
      const { main } = await import('../index.js');
      await main();
    } catch (err) {
      expect(err).toBe(exitError);
    }

    const versionMessages = [...infoSpy.mock.calls, ...errorSpy.mock.calls].map((call) => call[0]);
    const hasVersion = versionMessages.some(
      (message) => typeof message === 'string' && /\d+\.\d+\.\d+/.test(message)
    );
    expect(hasVersion).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('enables logs flag and strips args', async () => {
    process.argv = ['node', 'index.js', '--logs'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));
    const exitError = new Error('exit');
    exitSpy.mockImplementation(() => {
      throw exitError;
    });

    try {
      const { main } = await import('../index.js');
      await main();
    } catch (err) {
      expect(err).toBe(exitError);
    }

    expect(process.env.SMART_CODING_VERBOSE).toBe('true');
    expect(logsMock).toHaveBeenCalled();
  });

  it('prints last memory snapshot with --mem', async () => {
    process.argv = ['node', 'index.js', '--mem'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.readFile.mockResolvedValue(
      [
        '2026-02-02T00:00:00.000Z [INFO] [Server] Memory (startup) rss=100.0MB heap=10.0MB/20.0MB',
        '2026-02-02T00:00:05.000Z [INFO] [Server] Memory (after cache load) rss=150.0MB heap=15.0MB/25.0MB',
      ].join('\n')
    );
    const exitError = new Error('exit');
    exitSpy.mockImplementation(() => {
      throw exitError;
    });

    try {
      const { main } = await import('../index.js');
      await main();
    } catch (err) {
      expect(err).toBe(exitError);
    }

    const messages = [...infoSpy.mock.calls, ...errorSpy.mock.calls].map((call) => call[0]);
    const hasIdle = messages.some(
      (message) => typeof message === 'string' && message.includes('Idle snapshot')
    );
    const hasFallback = messages.some(
      (message) => typeof message === 'string' && message.includes('No memory snapshots found')
    );
    expect(hasIdle || hasFallback).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('rejects --clear with invalid cache id', async () => {
    process.argv = ['node', 'index.js', '--clear', '..\\..'];
    const exitError = new Error('exit');
    exitSpy.mockImplementation(() => {
      throw exitError;
    });

    try {
      const { main } = await import('../index.js');
      await main();
    } catch (err) {
      expect(err).toBe(exitError);
    }

    const errors = errorSpy.mock.calls.map((call) => call[0]);
    const hasInvalid = errors.some(
      (message) => typeof message === 'string' && message.includes('Invalid cache id')
    );
    expect(hasInvalid).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fsMock.access).not.toHaveBeenCalled();
  });

  it('logs startup/cache memory stats when verbose is enabled', async () => {
    process.argv = ['node', 'index.js'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue({
      ...baseConfig,
      verbose: true,
    });
    let accessResolve;
    const accessPromise = new Promise((resolve) => {
      accessResolve = resolve;
    });
    fsMock.access.mockReturnValue(accessPromise);
    pipelineMock.mockResolvedValue(() => ({}));
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(global, 'clearInterval');

    const { main } = await import('../index.js');
    const importPromise = main();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15000);
    accessResolve();
    await importPromise;

    const messages = infoSpy.mock.calls.map((call) => call[0]);
    const hasStartup = messages.some(
      (message) => typeof message === 'string' && message.includes('[Server] Memory (startup)')
    );
    const hasCacheLoad = messages.some(
      (message) =>
        typeof message === 'string' && message.includes('[Server] Memory (after cache load)')
    );
    expect(hasStartup).toBe(true);
    expect(hasCacheLoad).toBe(true);
    expect(clearSpy).toHaveBeenCalled();

    clearSpy.mockRestore();
  });

  it('handles lifecycle stop/start/status flags', async () => {
    const exitError = new Error('exit');
    exitSpy.mockImplementation(() => {
      throw exitError;
    });

    process.argv = ['node', 'index.js', '--stop'];
    stopMock.mockResolvedValue(undefined);
    try {
      const { main } = await import('../index.js');
      await main();
    } catch {}
    expect(stopMock).toHaveBeenCalled();

    vi.resetModules();
    process.argv = ['node', 'index.js', '--start'];
    startMock.mockResolvedValue(undefined);
    try {
      const { main } = await import('../index.js');
      await main();
    } catch {}
    expect(startMock).toHaveBeenCalled();

    vi.resetModules();
    process.argv = ['node', 'index.js', '--status'];
    statusMock.mockResolvedValue(undefined);
    try {
      const { main } = await import('../index.js');
      await main();
    } catch {}
    expect(statusMock).toHaveBeenCalled();
  });

  it('falls back when workspace variables are unexpanded', async () => {
    vi.useFakeTimers();
    process.argv = ['node', 'index.js', '--workspace', '${workspaceFolder}'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));

    const { main } = await import('../index.js');
    const mainPromise = main();
    await vi.runAllTimersAsync();
    await mainPromise;

    const errors = errorSpy.mock.calls.map((call) => call[0]);
    const hasFallback = errors.some(
      (message) => typeof message === 'string' && message.includes('IDE variable not expanded')
    );
    expect(hasFallback).toBe(true);
  });

  it('parses workspace args with equals and starts watcher', async () => {
    vi.useFakeTimers();
    process.argv = ['node', 'index.js', '--workspace=C:\\work'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue({
      ...baseConfig,
      watchFiles: true,
    });
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));

    const { main } = await import('../index.js');
    const mainPromise = main();
    await vi.runAllTimersAsync();
    await mainPromise;

    expect(setupFileWatcherMock).toHaveBeenCalled();
  });

  it('ignores workspace flag without a value', async () => {
    vi.useFakeTimers();
    process.argv = ['node', 'index.js', '--workspace'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));

    const { main } = await import('../index.js');
    const mainPromise = main();
    await vi.runAllTimersAsync();
    await mainPromise;

    const errors = errorSpy.mock.calls.map((call) => call[0]);
    const hasWorkspace = errors.some(
      (message) => typeof message === 'string' && message.includes('Workspace mode')
    );
    expect(hasWorkspace).toBe(false);
  });

  it('logs background indexing errors', async () => {
    vi.useFakeTimers();
    process.argv = ['node', 'index.js', '--workspace', 'C:\\work'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));
    indexAllMock.mockRejectedValue(new Error('index fail'));

    const { main } = await import('../index.js');
    const mainPromise = main();
    await vi.runAllTimersAsync();
    await mainPromise;

    const errors = errorSpy.mock.calls.map((call) => call[0]);
    const hasError = errors.some(
      (message) => typeof message === 'string' && message.includes('Background indexing error:')
    );
    expect(hasError).toBe(true);
  });

  it('parses workspace args and handles shutdown cleanup', async () => {
    vi.useFakeTimers();
    process.argv = ['node', 'index.js', '--workspace', 'C:\\work'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));

    const { main } = await import('../index.js');
    const mainPromise = main();
    await vi.runAllTimersAsync();
    await mainPromise;

    const info = [...infoSpy.mock.calls, ...errorSpy.mock.calls].map((call) => call[0]);
    const hasWorkspace = info.some(
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
    vi.useFakeTimers();
    process.argv = ['node', 'index.js', '--workspace', 'C:\\work'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));

    const { main } = await import('../index.js');
    const mainPromise = main();
    await vi.runAllTimersAsync();
    await mainPromise;

    lastIndexer.watcher = null;
    lastIndexer.terminateWorkers = null;
    lastCache = null;

    exitSpy.mockClear();
    const runHandler = async (handler) => {
      const promise = handler();
      await vi.runAllTimersAsync();
      await promise;
    };

    await runHandler(listeners.SIGINT);
    await runHandler(listeners.SIGTERM);

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('warns when log flush fails during shutdown', async () => {
    vi.useFakeTimers();
    process.argv = ['node', 'index.js', '--workspace', 'C:\\work'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));

    const { main } = await import('../index.js');
    const mainPromise = main();
    await vi.runAllTimersAsync();
    await mainPromise;

    loggingMock.flushLogs.mockRejectedValueOnce(new Error('flush boom'));
    const promise = listeners.SIGINT();
    await vi.runAllTimersAsync();
    await promise;

    const warned = warnSpy.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('Failed to flush logs: flush boom')
    );
    expect(warned).toBe(true);
  });

  it('treats uncaught EPIPE as graceful stdio shutdown', async () => {
    vi.useFakeTimers();
    process.argv = ['node', 'index.js', '--workspace', 'C:\\work'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));

    const { main } = await import('../index.js');
    const mainPromise = main();
    await vi.runAllTimersAsync();
    await mainPromise;

    listeners.uncaughtException({ code: 'EPIPE', message: 'broken pipe' });
    await vi.runAllTimersAsync();

    const errorMessages = errorSpy.mock.calls.map((call) => call[0]);
    const infoMessages = infoSpy.mock.calls.map((call) => call[0]);
    const hasFatal = errorMessages.some(
      (message) => typeof message === 'string' && message.includes('Fatal uncaughtException')
    );
    const requestedGraceful = infoMessages.some(
      (message) => typeof message === 'string' && message.includes('Shutdown requested (stdio-epipe)')
    );

    expect(hasFatal).toBe(false);
    expect(requestedGraceful).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('requests graceful shutdown on stderr EPIPE transport errors', async () => {
    vi.useFakeTimers();
    process.argv = ['node', 'index.js', '--workspace', 'C:\\work'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));
    const stderrListeners = {};
    const stderrOnSpy = vi
      .spyOn(process.stderr, 'on')
      .mockImplementation((event, handler) => {
        stderrListeners[event] = handler;
        return process.stderr;
      });

    try {
      const { main } = await import('../index.js');
      const mainPromise = main();
      await vi.runAllTimersAsync();
      await mainPromise;

      expect(typeof stderrListeners.error).toBe('function');
      stderrListeners.error({ code: 'EPIPE', message: 'stderr closed' });
      await vi.runAllTimersAsync();

      const infoMessages = infoSpy.mock.calls.map((call) => call[0]);
      const errorMessages = errorSpy.mock.calls.map((call) => call[0]);
      const requestedGraceful = infoMessages.some(
        (message) => typeof message === 'string' && message.includes('Shutdown requested (stderr-epipe)')
      );
      const hasFatal = errorMessages.some(
        (message) => typeof message === 'string' && message.includes('Fatal uncaughtException')
      );

      expect(requestedGraceful).toBe(true);
      expect(hasFatal).toBe(false);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      stderrOnSpy.mockRestore();
    }
  });

  it('lists tools and routes tool calls', async () => {
    vi.useFakeTimers();
    process.argv = ['node', 'index.js', '--workspace', 'C:\\work'];
    configMock.getGlobalCacheDir.mockReturnValue('C:\\cache-root');
    configMock.loadConfig.mockResolvedValue(baseConfig);
    fsMock.access.mockResolvedValue(undefined);
    pipelineMock.mockResolvedValue(() => ({}));

    const { main } = await import('../index.js');
    const mainPromise = main();
    await vi.runAllTimersAsync();
    await mainPromise;

    const listHandler = lastServer.handlers.get(listSchema);
    const callHandler = lastServer.handlers.get(callSchema);

    const listResponse = await listHandler();
    const toolNames = listResponse.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'semantic_search',
        'index-codebase',
        'clear_cache',
        'find_similar_code',
        'ann_config',
      ])
    );

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
      const { main } = await import('../index.js');
      await main();
    } catch (err) {}

    await listeners.SIGINT();
    await listeners.SIGTERM();

    const errors = errorSpy.mock.calls.map((call) => call[0]);
    const hasCacheSaved = errors.some(
      (message) => typeof message === 'string' && message.includes('Cache saved')
    );
    expect(hasCacheSaved).toBe(false);
  });
});
