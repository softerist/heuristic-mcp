import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('hnswlib-node', () => ({}));
import { EmbeddingsCache } from '../lib/cache.js';
import { HybridSearch } from '../features/hybrid-search.js';
import { DEFAULT_CONFIG } from '../lib/config.js';

describe('ANN Fallback (Missing hnswlib-node)', () => {
  let cache;
  let hybridSearch;
  let embedder;

  beforeEach(() => {
    // Mock configuration with ANN enabled
    const config = {
      ...DEFAULT_CONFIG,
      enableCache: false,
      cacheDirectory: './test-cache-ann',
      annEnabled: true,
      annMinChunks: 5, // Low threshold for testing
      annIndexCache: false,
      embeddingModel: 'test-model',
    };

    // Mock embedder
    embedder = vi.fn().mockResolvedValue({
      data: new Float32Array([0.1, 0.2, 0.3]),
    });

    cache = new EmbeddingsCache(config);

    // Populate vector store with dummy data
    const vectors = [];
    for (let i = 0; i < 10; i++) {
      vectors.push({
        file: `file${i}.js`,
        content: `content ${i}`,
        startLine: 1,
        endLine: 5,
        vector: [0.1, 0.2, 0.3], // simple dummy vector
      });
    }
    cache.setVectorStore(vectors);

    hybridSearch = new HybridSearch(embedder, cache, config);
  });

  it('should fall back to linear search when ANN index is unavailable', async () => {
    const query = 'test query';
    const maxResults = 5;

    const result = await hybridSearch.search(query, maxResults);

    expect(result).toBeDefined();
    expect(result.results.length).toBe(5);
    expect(embedder).toHaveBeenCalledWith(query, expect.any(Object));
    // Verify it didn't throw and ANN attempt doesn't prevent results
    const annAttempt = await cache.queryAnn([0.1, 0.2, 0.3], 5);
    expect(annAttempt).toBeNull();
  });

  it('should handle ANN loading failure gracefully', async () => {
    const index = await cache.ensureAnnIndex();
    expect(index).toBeNull();

    const annResults = await cache.queryAnn([0.1, 0.2, 0.3], 5);
    expect(annResults).toBeNull();
  });
});
