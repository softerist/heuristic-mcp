import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Enable worker error tests by default since we mock the worker properly
const runWorkerErrors = true;
const maybeDescribe = describe;

maybeDescribe('Worker Error Handling', () => {
  let indexer;
  let config;
  let cache;
  let workers;
  let WorkerConstructor;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    workers = [];
    WorkerConstructor = vi.fn(function () {
      const worker = new EventEmitter();
      worker.postMessage = vi.fn();
      worker.terminate = vi.fn();
      worker.threadId = workers.length + 1;
      workers.push(worker);
      queueMicrotask(() => {
        worker.emit('message', { type: 'ready' });
      });
      return worker;
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
    const initPromise = indexer.initializeWorkers();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await initPromise;

    const chunks = [{ text: 'a' }, { text: 'b' }];
    const fallbackSpy = vi.spyOn(indexer, 'processChunksSingleThreaded').mockResolvedValue([]);

    const promise = indexer.processChunksWithWorkers(chunks);

    // Trigger error
    await new Promise((r) => setTimeout(r, 10));

    try {
      // Emit error on the event emitter.
      // The indexer attached a listener via 'once'.
      // Vitest might complain if unhandled, so we wrap.
      workers[0].emit('error', new Error('Worker crash'));
    } catch (_e) { /* ignore */ }

    await promise;

    expect(fallbackSpy).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Worker 0 crashed'));
  });

  it('should handle worker startup failure', async () => {
    WorkerConstructor.mockImplementationOnce(function () {
      throw new Error('Init bad');
    });
    await indexer.initializeWorkers();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to create worker'));
  });
});
