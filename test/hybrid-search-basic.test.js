import { describe, it, expect, vi } from 'vitest';
import { HybridSearch } from '../features/hybrid-search.js';

describe('HybridSearch coverage', () => {
  it('skips duplicate chunks during exact match fallback (line 113 coverage)', async () => {
    const vectorStore = [
      {
        file: 'duplicate.js',
        content: 'exact match',
        startLine: 1,
        endLine: 2,
        vector: [1, 0]
      },
      {
        file: 'new.js',
        content: 'exact match',
        startLine: 1,
        endLine: 2,
        vector: [0, 1]
      }
    ];

    const cache = {
      getVectorStore: () => vectorStore,
      // ANN returns only the first chunk
      queryAnn: async () => [0],
      getRelatedFiles: async () => new Map()
    };

    const config = {
      annEnabled: true,
      // Ensure we get into the ANN path
      annMinCandidates: 0,
      annMaxCandidates: 10,
      annCandidateMultiplier: 1,
      // Need maxResults > exactMatchCount (which will be 1)
      maxResults: 5,
      semanticWeight: 1,
      exactMatchBoost: 1,
      recencyBoost: 0,
      callGraphEnabled: false,
      searchDirectory: '/test'
    };

    const embedder = async () => ({ data: new Float32Array([1, 0]) });
    
    const hybridSearch = new HybridSearch(embedder, cache, config);
    
    // Search for "exact match"
    // 1. ANN returns Chunk 0.
    // 2. exactMatchCount = 1 (Chunk 0 has "exact match").
    // 3. maxResults = 5. 1 < 5.
    // 4. Fallback loop starts.
    // 5. Checks Chunk 0. content matches. Key is in seen set. Line 113 -> continue.
    // 6. Checks Chunk 1. content matches. Key not in seen set. Added.
    
    const { results } = await hybridSearch.search('exact match', 5);
    
    expect(results).toHaveLength(2);
    expect(results.map(r => r.file).sort()).toEqual(['duplicate.js', 'new.js']);
  });
});
