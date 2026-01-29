import { describe, it, expect } from 'vitest';
import { HybridSearch } from '../features/hybrid-search.js';
import { createHybridSearchCacheStub } from './helpers.js';

describe('HybridSearch extra coverage', () => {
  it('handles missing chunk content in ANN fallback loop', async () => {
    const vectorStore = [
      {
        file: 'a.js',
        content: undefined,
        startLine: 1,
        endLine: 2,
        vector: [1, 0],
      },
      {
        file: 'b.js',
        content: 'no match here',
        startLine: 3,
        endLine: 4,
        vector: [0, 1],
      },
    ];

    const cache = createHybridSearchCacheStub({
      vectorStore,
      queryAnn: async () => [0, 1],
    });

    const config = {
      annEnabled: true,
      annMinCandidates: 0,
      annMaxCandidates: 10,
      annCandidateMultiplier: 1,
      maxResults: 2,
      semanticWeight: 1,
      exactMatchBoost: 1,
      recencyBoost: 0,
      callGraphEnabled: false,
      searchDirectory: '/test',
    };

    const embedder = async () => ({ data: new Float32Array([1, 0]) });
    const hybridSearch = new HybridSearch(embedder, cache, config);

    const { results } = await hybridSearch.search('ab', 2);

    expect(results).toHaveLength(2);
  });

  it('falls back with empty chunk content string', async () => {
    const vectorStore = [
      { file: 'x.js', content: undefined, startLine: 1, endLine: 1, vector: [1, 0] },
      { file: 'y.js', content: 'ab', startLine: 2, endLine: 2, vector: [0, 1] },
    ];

    const cache = createHybridSearchCacheStub({
      vectorStore,
      queryAnn: async () => [0, 1],
    });

    const config = {
      annEnabled: true,
      annMinCandidates: 0,
      annMaxCandidates: 10,
      annCandidateMultiplier: 1,
      maxResults: 2,
      semanticWeight: 1,
      exactMatchBoost: 1,
      recencyBoost: 0,
      callGraphEnabled: false,
      searchDirectory: '/test',
    };

    const embedder = async () => ({ data: new Float32Array([1, 0]) });
    const hybridSearch = new HybridSearch(embedder, cache, config);

    const { results } = await hybridSearch.search('ab', 2);

    expect(results).toHaveLength(2);
  });
});
