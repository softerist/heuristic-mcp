import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@huggingface/transformers', () => ({
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

import { pipeline } from '@huggingface/transformers';
import { parentPort } from 'worker_threads';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('embedding-worker coverage', () => {
  let messageHandler;

  beforeEach(() => {
    vi.resetModules();
    messageHandler = null;
    parentPort.on.mockReset();
    parentPort.on.mockImplementation((event, handler) => {
      if (event === 'message') messageHandler = handler;
    });
    parentPort.postMessage.mockReset();
    pipeline.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('converts plain arrays to Float32Array (line 11 coverage)', async () => {
    pipeline.mockResolvedValue(async () => ({
      data: [1, 2, 3],
    }));

    await import('../lib/embedding-worker.js');
    await tick();

    await messageHandler({
      type: 'process',
      chunks: [{ file: 'test.js', startLine: 1, endLine: 1, text: 'test' }],
      batchId: 'batch-array',
    });

    const resultsCall = parentPort.postMessage.mock.calls.find(
      (call) => call[0]?.type === 'results'
    );
    expect(resultsCall).toBeDefined();
    const result = resultsCall[0].results[0];

    expect(result.vector).toBeInstanceOf(Float32Array);
    expect(Array.from(result.vector)).toEqual([1, 2, 3]);
  });

  it('flushes intermediate results for large batches (lines 33-46 coverage)', async () => {
    pipeline.mockResolvedValue(async () => ({
      data: Float32Array.from([1]),
    }));

    await import('../lib/embedding-worker.js');
    await tick();

    const chunks = Array.from({ length: 30 }, (_, i) => ({
      file: `file${i}.js`,
      startLine: 1,
      endLine: 1,
      text: `chunk ${i}`,
    }));

    await messageHandler({
      type: 'process',
      chunks,
      batchId: 'batch-large',
    });

    const resultCalls = parentPort.postMessage.mock.calls.filter(
      (call) => call[0]?.type === 'results'
    );

    expect(resultCalls.length).toBeGreaterThanOrEqual(2);

    const firstCall = resultCalls[0][0];
    expect(firstCall.done).toBe(false);
    expect(firstCall.results.length).toBe(25);

    const lastCall = resultCalls[resultCalls.length - 1][0];
    expect(lastCall.done).toBe(true);
    expect(lastCall.results.length).toBe(5);
  });

  it('handles vectors without buffers gracefully (line 77 coverage)', async () => {
    pipeline.mockRejectedValueOnce(new Error('Critical failure'));

    await import('../lib/embedding-worker.js');
    await tick();

    pipeline.mockRejectedValue(new Error('Init failed permanently'));

    vi.resetModules();

    await import('../lib/embedding-worker.js');
    await tick();

    await messageHandler({
      type: 'process',
      chunks: [],
      batchId: 'batch-fail',
    });

    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        batchId: 'batch-fail',
      })
    );
  });

  it('hits toFloat32Array shortcut for Float32Array', async () => {
    const float32Data = new Float32Array([1, 2, 3]);
    pipeline.mockResolvedValue(async () => ({
      data: float32Data,
    }));

    await import('../lib/embedding-worker.js');
    await tick();

    await messageHandler({
      type: 'process',
      chunks: [{ file: 'test.js', startLine: 1, endLine: 1, text: 'test' }],
      batchId: 'batch-f32',
    });

    const resultsCall = parentPort.postMessage.mock.calls.find(
      (call) => call[0]?.type === 'results'
    );
    expect(resultsCall[0].results[0].vector).toEqual(float32Data);
  });

  it('hits flush without transferList and final postMessage without transferList', async () => {
    pipeline.mockResolvedValue(async () => {
      throw new Error('chunk fail');
    });

    await import('../lib/embedding-worker.js');
    await tick();

    const chunks = Array.from({ length: 25 }, (_, i) => ({
      file: `file${i}.js`,
      startLine: 1,
      endLine: 1,
      text: `chunk ${i}`,
    }));

    await messageHandler({
      type: 'process',
      chunks,
      batchId: 'batch-fail-25',
    });

    const resultsCalls = parentPort.postMessage.mock.calls.filter(
      (call) => call[0]?.type === 'results'
    );

    expect(resultsCalls).toHaveLength(2);
    expect(resultsCalls[0][1]).toBeUndefined();
    expect(resultsCalls[1][1]).toBeUndefined();
  });

  it('hits embedder caching and empty chunks', async () => {
    pipeline.mockResolvedValue(
      vi.fn().mockResolvedValue({
        data: new Float32Array([1]),
      })
    );

    await import('../lib/embedding-worker.js');
    await tick();

    await messageHandler({
      type: 'process',
      chunks: [{ file: 'test1.js', startLine: 1, endLine: 1, text: 'test1' }],
      batchId: 'batch1',
    });

    await messageHandler({
      type: 'process',
      chunks: [{ file: 'test2.js', startLine: 1, endLine: 1, text: 'test2' }],
      batchId: 'batch2',
    });

    await messageHandler({
      type: 'process',
      chunks: [],
      batchId: 'batch3',
    });

    const resultsCalls = parentPort.postMessage.mock.calls.filter(
      (call) => call[0]?.type === 'results'
    );

    expect(resultsCalls.length).toBeGreaterThanOrEqual(3);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });
});
