import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn(),
  env: {
    backends: {
      onnx: {
        wasm: { numThreads: null },
        numThreads: null,
      },
    },
  },
}));
vi.mock('worker_threads', () => ({
  parentPort: {
    on: vi.fn(),
    postMessage: vi.fn(),
  },
  workerData: {
    embeddingModel: 'test-model',
  },
}));

import { pipeline } from '@xenova/transformers';
import { parentPort, workerData } from 'worker_threads';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('embedding-worker', () => {
  let exitSpy;
  let messageHandler;

  beforeEach(() => {
    vi.resetModules();
    messageHandler = null;
    parentPort.on.mockReset();
    parentPort.on.mockImplementation((event, handler) => {
      if (event === 'message') messageHandler = handler;
    });
    parentPort.postMessage.mockReset();
    workerData.embeddingModel = 'test-model';
    pipeline.mockReset();
    pipeline.mockImplementation(() => Promise.resolve({}));
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('processes chunks and posts results', async () => {
    pipeline.mockResolvedValue(async () => ({
      data: Float32Array.from([1, 2]),
    }));

    await import('../lib/embedding-worker.js');
    await tick();

    expect(parentPort.postMessage).toHaveBeenCalledWith({ type: 'ready' });

    await messageHandler({
      type: 'process',
      chunks: [{ file: 'a.js', startLine: 1, endLine: 2, text: 'code' }],
      batchId: 'batch-1',
    });

    const resultsCall = parentPort.postMessage.mock.calls.find(
      (call) => call[0]?.type === 'results'
    );
    expect(resultsCall).toBeDefined();
    const [payload, transferList] = resultsCall;
    expect(payload.batchId).toBe('batch-1');
    expect(payload.done).toBe(true);
    expect(payload.results).toHaveLength(1);
    const result = payload.results[0];
    expect(result.vector).toBeInstanceOf(Float32Array);
    expect(Array.from(result.vector)).toEqual([1, 2]);
    expect(transferList).toEqual([result.vector.buffer]);
  });

  it('captures embedding errors per chunk', async () => {
    pipeline.mockResolvedValue(async () => {
      throw new Error('embed fail');
    });

    await import('../lib/embedding-worker.js');
    await tick();

    await messageHandler({
      type: 'process',
      chunks: [{ file: 'b.js', startLine: 3, endLine: 4, text: 'bad' }],
      batchId: 'batch-2',
    });

    const message = parentPort.postMessage.mock.calls.find((call) => call[0].type === 'results')[0];
    expect(message.results[0].success).toBe(false);
    expect(message.results[0].error).toBe('embed fail');
  });

  it('reports initialization failures', async () => {
    pipeline.mockRejectedValue(new Error('init fail'));

    await import('../lib/embedding-worker.js');
    await tick();

    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'error',
      error: 'init fail',
    });
  });

  it('reports process errors when initialization fails', async () => {
    pipeline.mockRejectedValue(new Error('init fail'));

    await import('../lib/embedding-worker.js');
    await tick();

    await messageHandler({
      type: 'process',
      chunks: [{ file: 'c.js', startLine: 1, endLine: 2, text: 'x' }],
      batchId: 'batch-3',
    });

    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'error',
      error: 'init fail',
      batchId: 'batch-3',
    });
  });

  it('shuts down on shutdown messages', async () => {
    pipeline.mockResolvedValue(async () => ({
      data: Float32Array.from([1, 2]),
    }));

    await import('../lib/embedding-worker.js');
    await tick();

    await messageHandler({ type: 'shutdown' });

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('ignores unknown message types', async () => {
    await import('../lib/embedding-worker.js');
    await tick();

    await messageHandler({ type: 'unknown' });

    // Should throw error for unknown message type
    expect(parentPort.postMessage).toHaveBeenCalledTimes(2);
    expect(parentPort.postMessage).toHaveBeenCalledWith({ type: 'ready' });
    expect(parentPort.postMessage).toHaveBeenCalledWith({ 
      type: 'error', 
      error: 'Unknown message type: unknown' 
    });
  });
});
