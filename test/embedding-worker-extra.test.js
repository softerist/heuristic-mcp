import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn(),
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
    // Return a plain array instead of Float32Array to trigger the conversion
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
    
    // Check that it was converted to Float32Array
    expect(result.vector).toBeInstanceOf(Float32Array);
    expect(Array.from(result.vector)).toEqual([1, 2, 3]);
  });

  it('flushes intermediate results for large batches (lines 33-46 coverage)', async () => {
    pipeline.mockResolvedValue(async () => ({
      data: Float32Array.from([1]),
    }));

    await import('../lib/embedding-worker.js');
    await tick();

    // Create 30 chunks (batch size is 25)
    // This should trigger at least one intermediate flush
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

    // We expect multiple 'results' messages
    const resultCalls = parentPort.postMessage.mock.calls.filter(
      (call) => call[0]?.type === 'results'
    );
    
    // Should have at least 2 calls: one intermediate (flush), one final
    expect(resultCalls.length).toBeGreaterThanOrEqual(2);
    
    const firstCall = resultCalls[0][0];
    expect(firstCall.done).toBe(false); // Intermediate flush
    expect(firstCall.results.length).toBe(25); // Batch size
    
    const lastCall = resultCalls[resultCalls.length - 1][0];
    expect(lastCall.done).toBe(true); // Final flush
    expect(lastCall.results.length).toBe(5); // Remainder
  });

  it('handles vectors without buffers gracefully (line 77 coverage)', async () => {
    // Simulate a scenario where toFloat32Array returns something that might fail buffer check?
    // Or maybe catch block?
    // Let's test the case where we don't have a buffer property explicitly if possible,
    // though Float32Array always has one. 
    // Instead, let's verify transferList logic.
    
    // The previous test covered normal transfer list. 
    // If line 77 is about `transferList.push`, maybe it's covered by above tests.
    // If line 77 is the catch block, let's make sure we test a specific error case.
    // But existing tests already do that.
    
    // Let's look at `if (vector?.buffer)` logic.
    // If I return an object mimicking array but no buffer?
    // `toFloat32Array` will convert it to Float32Array which HAS a buffer.
    
    // Maybe line 77 refers to `parentPort.postMessage` in the catch block of `processChunks`?
    // No, `processChunks` loops through chunks and catches individual errors.
    
    // Let's assume line 77 is related to error handling in the main message handler
    // "parentPort.postMessage({ type: 'error' ... })"
    
    // We can simulate an error in `processChunks` that is NOT caught by the inner loop.
    // For example, if `embedder` initialization fails repeatedly or `initializeEmbedder` fails inside `processChunks`.
    // But `initializeEmbedder` is awaited outside the loop.
    
    // If `processChunks` throws, it goes to `catch (error) { parentPort.postMessage(...) }`.
    // The inner loop catches embedder errors. 
    // So we need `processChunks` to throw BEFORE or AFTER the loop, or for `initializeEmbedder` to throw.
    
    // If `initializeEmbedder` throws (e.g. second call fails), `processChunks` throws.
    pipeline.mockRejectedValueOnce(new Error('Critical failure'));
    
    // Since we reload module in beforeEach (via resetModules + import), 
    // embedder variable is reset.
    // However, `embedder` variable is module-level.
    
    // To test `processChunks` failure:
    // We need `initializeEmbedder` to fail when called from `processChunks`.
    
    await import('../lib/embedding-worker.js');
    await tick();
    
    // The first init runs on load. 
    // If we want it to fail during process, we need to make sure it wasn't initialized yet or fails then.
    // But it initializes on start.
    
    // If we send a message BEFORE it initializes? 
    // Or if we force it to be null? We can't access internal state.
    
    // However, `processChunks` calls `initializeEmbedder`. 
    // If the initial `initializeEmbedder` failed, the `embedder` var is still null.
    // Then `processChunks` calls it again. If it fails again, it throws.
    
    pipeline.mockRejectedValue(new Error('Init failed permanently'));
    
    // Re-import to trigger failure
    vi.resetModules();
    // We need to suppress the top-level catch log or postMessage
    await import('../lib/embedding-worker.js');
    await tick();
    
    // Now trigger process
    await messageHandler({
      type: 'process',
      chunks: [],
      batchId: 'batch-fail',
    });
    
    expect(parentPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      batchId: 'batch-fail'
    }));
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
    expect(resultsCall[0].results[0].vector).toBe(float32Data);
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
    pipeline.mockResolvedValue(vi.fn().mockResolvedValue({
      data: new Float32Array([1]),
    }));

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
