import { describe, it, expect, vi, beforeEach } from 'vitest';


vi.mock('fs/promises');


vi.mock('hnswlib-node', () => {
  throw new Error('Module not found or load error');
});

describe('EmbeddingsCache HNSW Failures', () => {
  it('should handle hnswlib import failure gracefully', async () => {
    
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

    
    cache.vectorStore = [
      { file: 'a.js', vector: [1, 0] },
      { file: 'b.js', vector: [0, 1] },
    ];

    
    const index = await cache.ensureAnnIndex();

    
    expect(index).toBeNull();

    
  });
});
