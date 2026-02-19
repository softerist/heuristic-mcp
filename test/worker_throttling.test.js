import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodebaseIndexer } from '../features/index-codebase.js';
import os from 'os';

vi.mock('os');
vi.mock('../lib/embedding-worker.js', () => {
  return {
    default: class MockWorker {
      constructor() {
        this.on = vi.fn();
        this.once = vi.fn();
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
        
        setTimeout(() => {
          const calls = this.once.mock.calls;
          const readyHandler = calls.find((c) => c[0] === 'message')?.[1];
          if (readyHandler) readyHandler({ type: 'ready' });
        }, 10);
      }
    },
  };
});


vi.mock('worker_threads', () => {
  return {
    Worker: class {
      constructor() {
        this.on = vi.fn();
        this.once = vi.fn();
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
        setTimeout(() => {
          const calls = this.once.mock.calls;
          const readyHandler = calls.find((c) => c[0] === 'message')?.[1];
          if (readyHandler) readyHandler({ type: 'ready' });
        }, 10);
      }
    },
  };
});

describe('CodebaseIndexer RAM Throttling', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  it('should throttle workers when RAM is low', async () => {
    
    os.cpus.mockReturnValue(Array(16).fill({}));
    
    os.freemem.mockReturnValue(2 * 1024 * 1024 * 1024);

    const config = {
      workerThreads: 10, 
      embeddingModel: 'jinaai/jina-embeddings-v2-base-code',
      verbose: true,
      searchDirectory: '/tmp',
    };

    const indexer = new CodebaseIndexer({}, {}, config);

    
    
    
    

    await indexer.initializeWorkers();

    const activeWorkers = indexer.workers.length;
    console.log(`Initialized ${activeWorkers} workers`);

    
    
    
    expect(activeWorkers).toBeLessThan(10);
    expect(activeWorkers).toBe(1); 
  });
});
