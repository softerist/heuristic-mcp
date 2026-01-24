import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

describe.skip('Worker Error Handling', () => {
  let indexer;
  let config;
  let cache;
  let mockWorker;
  let WorkerConstructor;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockWorker = new EventEmitter();
    mockWorker.postMessage = vi.fn();
    mockWorker.terminate = vi.fn();
    mockWorker.threadId = 1;

    // Auto-reply ready to ensure initialization passes
    mockWorker.on = vi.fn((event, _cb) => {
      if (event === 'message')
        setTimeout(() => {
          // Only emit ready if not already emitted?
          // Simpler: just emit.
          // Note: 'on' is called for 'message' listener in initializeWorkers
          mockWorker.emit('message', { type: 'ready' });
        }, 0);
      return mockWorker;
    });
    // Ignore once implementation detail for simplicity or match it
    mockWorker.once = vi.fn((event, _cb) => {
      if (event === 'message')
        setTimeout(() => {
          mockWorker.emit('message', { type: 'ready' });
        }, 0);
      return mockWorker;
    });
    mockWorker.removeListener = vi.fn();

    // Factory returning our single instance
    WorkerConstructor = vi.fn(function () {
      return mockWorker;
    });

    vi.doMock('worker_threads', () => ({
      Worker: WorkerConstructor,
    }));

    vi.doMock('os', () => ({
      default: { cpus: () => [{}, {}, {}, {}] },
      cpus: () => [{}, {}, {}, {}],
    }));

    // Dynamic import
    const { CodebaseIndexer } = await import('../features/index-codebase.js');

    config = {
      workerThreads: 2,
      verbose: true,
      embeddingModel: 'test',
    };

    cache = {
      addToStore: vi.fn(),
    };

    indexer = new CodebaseIndexer(vi.fn(), cache, config, null);

    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should handle offline workers and fallback', async () => {
    await indexer.initializeWorkers();

    const chunks = [{ text: 'a' }, { text: 'b' }];
    const fallbackSpy = vi.spyOn(indexer, 'processChunksSingleThreaded').mockResolvedValue(2);

    const promise = indexer.processChunksWithWorkers(chunks);

    // Trigger error
    await new Promise((r) => setTimeout(r, 10));

    try {
      // Emit error on the event emitter.
      // The indexer attached a listener via 'once'.
      // Vitest might complain if unhandled, so we wrap.
      mockWorker.emit('error', new Error('Worker crash'));
    } catch (_e) { /* ignore */ }

    await promise;

    expect(fallbackSpy).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Worker 0 crashed'));
  });

  it('should handle worker startup failure', async () => {
    WorkerConstructor.mockImplementationOnce(() => {
      throw new Error('Init bad');
    });
    await indexer.initializeWorkers();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to create worker'));
  });
});
