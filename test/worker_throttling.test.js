
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
            // Simulate ready immediately
            setTimeout(() => {
                const calls = this.once.mock.calls;
                const readyHandler = calls.find(c => c[0] === 'message')?.[1];
                if (readyHandler) readyHandler({ type: 'ready' });
            }, 10);
        }
    }
  };
});

// Mock Worker from worker_threads
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
                    const readyHandler = calls.find(c => c[0] === 'message')?.[1];
                    if (readyHandler) readyHandler({ type: 'ready' });
                }, 10);
            }
        }
    };
});


describe('CodebaseIndexer RAM Throttling', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    // Trick the module into thinking we are NOT in a test env so throttling runs
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  it('should throttle workers when RAM is low', async () => {
    // Mock 16 cores
    os.cpus.mockReturnValue(Array(16).fill({}));
    // Mock 2GB free memory (enough for ~1 worker @ 1.5GB/worker)
    os.freemem.mockReturnValue(2 * 1024 * 1024 * 1024);

    const config = {
      workerThreads: 10, // Simulated "resolved" auto count or user explicit
      embeddingModel: 'jinaai/jina-embeddings-v2-base-code',
      verbose: true,
      searchDirectory: '/tmp'
    };

    const indexer = new CodebaseIndexer({}, {}, config);
    
    // We expect initializeWorkers to NOT throttle effectively because it checks for 'auto'
    // but we are passing a number (10).
    // Current buggy behavior: It uses 10 workers.
    // Desired behavior: It sees 2GB RAM and throttles to ~1 worker.

    await indexer.initializeWorkers();

    const activeWorkers = indexer.workers.length;
    console.log(`Initialized ${activeWorkers} workers`);
    
    // CURRENTLY BROKEN: This expectation represents the BUG.
    // It SHOULD be 1, but it WILL be 10.
    // We write the test to expect 1 (the correct behavior), so it fails now.
    expect(activeWorkers).toBeLessThan(10); 
    expect(activeWorkers).toBe(1); // 2GB / ~1.5GB = 1 worker
  });
});
