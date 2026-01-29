
import { describe, it, expect, vi } from 'vitest';
import { HybridSearch } from '../features/hybrid-search.js';
import fs from 'fs/promises';

describe('HybridSearch Branch Coverage', () => {
  it('should handle fs.stat errors in populateFileModTimes', async () => {
    const config = {
      annEnabled: false,
      semanticWeight: 1,
      exactMatchBoost: 0,
      recencyBoost: 0.5,
      recencyDecayDays: 30,
      callGraphEnabled: false,
      callGraphBoost: 0,
      searchDirectory: '/mock',
    };
    const embedder = vi.fn();
    const cache = {
      getVectorStore: () => [],
      getStoreSize: () => 0,
      getFileMeta: () => null,
    };
    const hybrid = new HybridSearch(embedder, cache, config);

    // Mock fs.stat to fail for one file and succeed for another
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (path) => {
      if (path === 'fail.js') {
        throw new Error('stat failed');
      }
      return { mtimeMs: 1000 };
    });

    await hybrid.populateFileModTimes(['success.js', 'fail.js']);

    expect(hybrid.fileModTimes.get('success.js')).toBe(1000);
    expect(hybrid.fileModTimes.get('fail.js')).toBeNull();

    statSpy.mockRestore();
  });

  it('should return early from populateFileModTimes if no missing files', async () => {
      const hybrid = new HybridSearch({}, {}, {});
      hybrid.fileModTimes.set('a.js', 100);
      
      const statSpy = vi.spyOn(fs, 'stat');
      await hybrid.populateFileModTimes(['a.js']);
      
      expect(statSpy).not.toHaveBeenCalled();
      statSpy.mockRestore();
  });

  it('should handle null mtime in scoring', async () => {
    const vectorStore = [
      {
        file: 'null-mtime.js',
        content: 'content',
        vector: [1, 0],
        startLine: 1,
        endLine: 1,
      },
    ];
    const cache = {
      getVectorStore: () => vectorStore,
      queryAnn: async () => null,
      getRelatedFiles: async () => new Map(),
      getStoreSize: () => vectorStore.length,
      getVector: (idx) => vectorStore[idx]?.vector,
      getChunk: (idx) => vectorStore[idx],
      getChunkContent: (idx) => vectorStore[idx]?.content,
      startRead: () => {},
      endRead: () => {},
      waitForReaders: async () => {},
    };
    const config = {
      annEnabled: false,
      semanticWeight: 1,
      exactMatchBoost: 0,
      recencyBoost: 0.5,
      recencyDecayDays: 30,
      callGraphEnabled: false,
      callGraphBoost: 0,
      searchDirectory: '/mock',
    };
    const embedder = async () => ({ data: new Float32Array([1, 0]) });
    const hybrid = new HybridSearch(embedder, cache, config);
    
    // Explicitly set null mtime
    hybrid.fileModTimes.set('null-mtime.js', null);

    const { results } = await hybrid.search('query', 1);
    expect(results[0].score).toBe(1); // Only semantic weight
  });

  it('should skip call graph boost if no symbols from top results', async () => {
    const vectorStore = [
      {
        file: 'no-symbols.js',
        content: '', // Empty content -> no symbols
        vector: [1, 0],
        startLine: 1,
        endLine: 1,
      },
    ];
    const cache = {
      getVectorStore: () => vectorStore,
      queryAnn: async () => null,
      getRelatedFiles: vi.fn(),
      getStoreSize: () => vectorStore.length,
      getVector: (idx) => vectorStore[idx]?.vector,
      getChunk: (idx) => vectorStore[idx],
      getChunkContent: (idx) => vectorStore[idx]?.content,
      startRead: () => {},
      endRead: () => {},
      waitForReaders: async () => {},
    };
    const config = {
      annEnabled: false,
      semanticWeight: 1,
      exactMatchBoost: 0,
      recencyBoost: 0,
      callGraphEnabled: true,
      callGraphBoost: 0.5,
      searchDirectory: '/mock',
    };
    const embedder = async () => ({ data: new Float32Array([1, 0]) });
    const hybrid = new HybridSearch(embedder, cache, config);

    await hybrid.search('query', 1);
    expect(cache.getRelatedFiles).not.toHaveBeenCalled();
  });

  it('should skip chunks without content in exact match fallback (line 113)', async () => {
    const vectorStore = [
      {
        file: 'no-content.js',
        content: null,
        vector: [1, 0],
        startLine: 1,
        endLine: 1,
      },
    ];
    const cache = {
      getVectorStore: () => vectorStore,
      queryAnn: async () => [0], // ANN finds it
      getRelatedFiles: async () => new Map(),
      getStoreSize: () => vectorStore.length,
      getVector: (idx) => vectorStore[idx]?.vector,
      getChunk: (idx) => vectorStore[idx],
      getChunkContent: (idx) => vectorStore[idx]?.content,
      startRead: () => {},
      endRead: () => {},
      waitForReaders: async () => {},
    };
    const config = {
      annEnabled: true,
      annMinCandidates: 0,
      annMaxCandidates: 10,
      annCandidateMultiplier: 1,
      semanticWeight: 1,
      exactMatchBoost: 1,
      recencyBoost: 0,
      callGraphEnabled: false,
      callGraphBoost: 0,
      searchDirectory: '/mock',
    };
    const embedder = async () => ({ data: new Float32Array([1, 0]) });
    const hybrid = new HybridSearch(embedder, cache, config);

    // We need exactMatchCount < maxResults to trigger the fallback block
    // ANN returns usedAnn = true.
    // candidates = [chunk0].
    // exactMatchCount = 0 (chunk0 has no content).
    // exactMatchCount < maxResults (2).
    // Fallback block is entered.
    // Iterates vectorStore. chunk0 is skipped because chunk.content is null.
    const { results } = await hybrid.search('target', 2);
    expect(results).toHaveLength(1);
  });

  it('should cover line 113: skip redundant chunk during exact match fallback', async () => {
    const vectorStore = [
      {
        file: 'match.js',
        content: 'target match',
        vector: [1, 0],
        startLine: 1,
        endLine: 1,
      }
    ];
    const cache = {
      getVectorStore: () => vectorStore,
      queryAnn: async () => [0], // ANN finds it!
      getRelatedFiles: async () => new Map(),
      getStoreSize: () => vectorStore.length,
      getVector: (idx) => vectorStore[idx]?.vector,
      getChunk: (idx) => vectorStore[idx],
      getChunkContent: (idx) => vectorStore[idx]?.content,
      startRead: () => {},
      endRead: () => {},
      waitForReaders: async () => {},
    };
    const config = {
      annEnabled: true,
      annMinCandidates: 0,
      annMaxCandidates: 10,
      annCandidateMultiplier: 1,
      semanticWeight: 1,
      exactMatchBoost: 1,
      recencyBoost: 0,
      callGraphEnabled: false,
      callGraphBoost: 0,
      searchDirectory: '/mock',
    };
    const embedder = async () => ({ data: new Float32Array([1, 0]) });
    const hybrid = new HybridSearch(embedder, cache, config);

    // Flow:
    // 1. usedAnn = true.
    // 2. candidates = [chunk0].
    // 3. exactMatchCount = 1.
    // 4. maxResults = 2.
    // 5. exactMatchCount < maxResults -> Fallback entered (line 110).
    // 6. seen = Set(['match.js:1:1']).
    // 7. Loop vectorStore:
    //    - chunk0: content matches 'target'.
    //    - key = 'match.js:1:1'.
    //    - seen.has(key) is TRUE -> continues (line 113 COVERAGE).
    const { results } = await hybrid.search('target', 2);
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe('match.js');
  });
});
