import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodebaseIndexer } from '../features/index-codebase.js';


vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('events');
  class Worker extends EventEmitter {
    constructor(path, options) {
      super();
      this.path = path;
      this.options = options;

      
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


vi.mock('os', async () => {
  const actual = await vi.importActual('os');
  return {
    ...actual,
    default: {
      ...actual, 
      cpus: () => [{}, {}, {}, {}], 
    },
    cpus: () => [{}, {}, {}, {}], 
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
    
    
    await indexer.initializeWorkers();

    expect(indexer.workers.length).toBe(2);
    
    expect(indexer.workers[0]).toBeDefined();
  });

  it('should handle worker initialization failure (Line 134)', async () => {
    config.embeddingModel = 'fail-model';
    
    
    

    
    

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await indexer.initializeWorkers();

    
    
    expect(indexer.workers.length).toBe(0);

    
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Worker initialization failed')
    );

    consoleSpy.mockRestore();
  });
});
