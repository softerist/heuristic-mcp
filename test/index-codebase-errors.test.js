import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodebaseIndexer } from '../features/index-codebase.js';
import { EventEmitter } from 'events';

// Mock worker_threads
vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('events');
  class Worker extends EventEmitter {
    constructor(path, options) {
      super();
      this.path = path;
      this.options = options;
      setTimeout(() => {
        this.emit('message', { type: 'ready' });
      }, 10);
    }
    terminate() {
      return Promise.resolve();
    }
    postMessage(msg) {
      if (msg.type === 'process') {
        // Simulate error response for specific batch
        if (msg.batchId.includes('error-batch')) {
          setTimeout(() => {
            this.emit('message', {
              type: 'error',
              error: 'Simulated Processing Error',
              batchId: msg.batchId,
            });
          }, 10);
        } else {
          setTimeout(() => {
            this.emit('message', {
              type: 'results',
              results: [{ success: true, file: 'test.js' }],
              batchId: msg.batchId,
            });
          }, 10);
        }
      }
    }
  }
  return { Worker };
});

vi.mock('os', async () => {
  const actual = await vi.importActual('os');
  return {
    ...actual,
    default: { ...actual, cpus: () => [{}, {}, {}, {}] },
    cpus: () => [{}, {}, {}, {}],
  };
});

describe('CodebaseIndexer Error Handling', () => {
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
    cache = { save: vi.fn(), getVectorStore: () => [] };
    embedder = vi.fn().mockResolvedValue({ data: [] });
    indexer = new CodebaseIndexer(embedder, cache, config);
  });

  afterEach(async () => {
    await indexer.terminateWorkers();
    vi.restoreAllMocks();
  });

  it('should handle worker error message during processing (Line 253)', async () => {
    await indexer.initializeWorkers();

    // Force a batch ID that triggers the error in our mock
    // We can't easily force the batchId inside processChunksWithWorkers,
    // but we can rely on the mock behavior if we spy/control Date.now or similar.
    // Actually, the mock above checks for "error-batch" in batchId.
    // But the real code generates `batch-${i}-${Date.now()}`.
    // So we can't easily make it include "error-batch".

    // Alternative: Replace the worker instance with a custom one that emits error
    // regardless of batchId, but wait, the handler checks batchId match.

    // Let's modify the indexer.workers[0] directly before calling processChunksWithWorkers
    const worker = indexer.workers[0];
    const originalPostMessage = worker.postMessage;

    worker.postMessage = (msg) => {
      if (msg.type === 'process') {
        setTimeout(() => {
          worker.emit('message', {
            type: 'error',
            error: 'Forced Error',
            batchId: msg.batchId, // Echo back the correct batchId
          });
        }, 10);
      }
    };

    const chunks = [{ text: 'content', file: 'f1.js' }];

    // We expect it to log error and resolve with empty array (and then retry single threaded)
    // Since we mock embedder, the single threaded retry should succeed.

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await indexer.processChunksWithWorkers(chunks);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Worker 0 error: Forced Error')
    );
    consoleSpy.mockRestore();
  });

  it('should handle terminate error (Line 168)', async () => {
    await indexer.initializeWorkers();

    // Mock terminate to fail
    indexer.workers[0].terminate = vi.fn().mockRejectedValue(new Error('Terminate fail'));

    // Should not throw
    await indexer.terminateWorkers();

    expect(indexer.workers.length).toBe(0);
  });
});
