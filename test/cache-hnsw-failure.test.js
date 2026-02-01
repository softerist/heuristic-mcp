import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs to avoid actual file I/O
vi.mock('fs/promises');

// Mock hnswlib-node to fail loading
vi.mock('hnswlib-node', () => {
  throw new Error('Module not found or load error');
});

describe('EmbeddingsCache HNSW Failures', () => {
  it('should handle hnswlib import failure gracefully', async () => {
    // Need to dynamic import cache to trigger the hnswlib import attempt (if it wasn't already cached by other tests, but Vitest isolates files)
    const { EmbeddingsCache } = await import('../lib/cache.js');

    const config = {
      enableCache: true,
      annEnabled: true,
      annMinChunks: 1,
      cacheDirectory: '/tmp/test-hnsw-fail',
      fileExtensions: ['js'],
      embeddingModel: 'test',
    };
    const cache = new EmbeddingsCache(config);

    // Add chunks to trigger ANN condition
    cache.vectorStore = [
      { file: 'a.js', vector: [1, 0] },
      { file: 'b.js', vector: [0, 1] },
    ];

    // Attempt to ensure index
    const index = await cache.ensureAnnIndex();

    // Should be null because hnswlib failed to load
    expect(index).toBeNull();

    // Should also check console.error behavior if desired
  });
});
