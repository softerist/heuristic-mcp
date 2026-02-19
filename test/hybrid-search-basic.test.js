import { describe, it, expect, vi } from 'vitest';
import { HybridSearch } from '../features/hybrid-search.js';
import { createHybridSearchCacheStub } from './helpers.js';

describe('HybridSearch coverage', () => {
  it('skips duplicate chunks during exact match fallback (line 113 coverage)', async () => {
    const vectorStore = [
      {
        file: 'duplicate.js',
        content: 'exact match',
        startLine: 1,
        endLine: 2,
        vector: [1, 0],
      },
      {
        file: 'new.js',
        content: 'exact match',
        startLine: 1,
        endLine: 2,
        vector: [0, 1],
      },
    ];

    const cache = createHybridSearchCacheStub({
      vectorStore,

      queryAnn: async () => [0],
    });

    const config = {
      annEnabled: true,

      annMinCandidates: 0,
      annMaxCandidates: 10,
      annCandidateMultiplier: 1,

      maxResults: 5,
      semanticWeight: 1,
      exactMatchBoost: 1,
      recencyBoost: 0,
      callGraphEnabled: false,
      searchDirectory: '/test',
    };

    const embedder = async () => ({ data: new Float32Array([1, 0]) });

    const hybridSearch = new HybridSearch(embedder, cache, config);

    const { results } = await hybridSearch.search('exact match', 5);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.file).sort()).toEqual(['duplicate.js', 'new.js']);
  });
});
