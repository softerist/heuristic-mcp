import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(),
  env: {
    backends: {
      onnx: {
        numThreads: 1,
        wasm: { numThreads: 1 },
      },
    },
  },
}));

vi.mock('../lib/onnx-backend.js', () => ({
  configureNativeOnnxBackend: vi.fn(),
}));

describe('embedding-process getEmbedder', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reloads the embedder when the model changes', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    pipeline.mockResolvedValueOnce({}).mockResolvedValueOnce({});

    const { getEmbedder, resetEmbeddingProcessState } = await import('../lib/embedding-process.js');

    resetEmbeddingProcessState();
    await getEmbedder('model-a', 1);
    await getEmbedder('model-b', 1);

    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(pipeline.mock.calls[0][1]).toBe('model-a');
    expect(pipeline.mock.calls[1][1]).toBe('model-b');
    expect(pipeline.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        session_options: expect.objectContaining({
          numThreads: 1,
          intraOpNumThreads: 1,
          interOpNumThreads: 1,
        }),
      })
    );
  });
});
