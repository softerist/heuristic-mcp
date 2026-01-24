import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodebaseIndexer } from '../features/index-codebase.js';

// Mock worker_threads
vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('events');
  class Worker extends EventEmitter {
    constructor(path, options) {
      super();
      this.path = path;
      this.options = options;

      // Simulate async initialization
      setTimeout(() => {
        if (options.workerData && options.workerData.embeddingModel === 'fail-model') {
          this.emit('message', { type: 'error', error: 'Simulated Init Failure' });
        } else {
          this.emit('message', { type: 'ready' });
        }
      }, 10);
    }
    terminate() {
      return Promise.resolve();
    }
    postMessage(msg) {}
  }
  return { Worker };
});

// Mock os to ensure we have multiple CPUs
vi.mock('os', async () => {
  const actual = await vi.importActual('os');
  return {
    ...actual,
    default: {
      ...actual, // Spread actual properties to default for default import compatibility
      cpus: () => [{}, {}, {}, {}], // 4 CPUs
    },
    cpus: () => [{}, {}, {}, {}], // Named export
  };
});

describe('CodebaseIndexer Worker Initialization', () => {
  let indexer;
  let config;
  let cache;
  let embedder;

  beforeEach(() => {
    config = {
      workerThreads: 2,
      verbose: true,
      embeddingModel: 'test-model',
    };
    cache = {
      save: vi.fn(),
      getVectorStore: () => [],
    };
    embedder = vi.fn();
    indexer = new CodebaseIndexer(embedder, cache, config);
  });

  afterEach(async () => {
    await indexer.terminateWorkers();
    vi.restoreAllMocks();
  });

  it('should initialize workers successfully and handle ready message (Line 132)', async () => {
    // This triggers initializeWorkers with 2 workers
    // The mock Worker emits "ready", so line 132 should be executed
    await indexer.initializeWorkers();

    expect(indexer.workers.length).toBe(2);
    // Also verify workers are in the array
    expect(indexer.workers[0]).toBeDefined();
  });

  it('should handle worker initialization failure (Line 134)', async () => {
    config.embeddingModel = 'fail-model';
    // This will cause the mock worker to emit "error"
    // initializeWorkers catches the error and falls back to single threaded
    // But specifically we want to see if it catches the error from the promise.

    // initializeWorkers catches errors internally and logs them, then terminates workers.
    // It doesn't throw.

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await indexer.initializeWorkers();

    // It should have failed to initialize workers, so workers array should be empty
    // (because terminateWorkers is called in catch block)
    expect(indexer.workers.length).toBe(0);

    // Check if error was logged
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Worker initialization failed')
    );

    consoleSpy.mockRestore();
  });
});
