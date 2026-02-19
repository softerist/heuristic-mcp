import { describe, it, expect, vi } from 'vitest';
import { HybridSearch } from '../features/hybrid-search.js';
import { createHybridSearchCacheStub } from './helpers.js';
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
    const cache = createHybridSearchCacheStub({
      vectorStore: [],
      getFileMeta: () => null,
    });
    const hybrid = new HybridSearch(embedder, cache, config);

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
    const hybrid = new HybridSearch({}, createHybridSearchCacheStub(), {});
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
    const cache = createHybridSearchCacheStub({
      vectorStore,
      queryAnn: async () => null,
    });
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

    hybrid.fileModTimes.set('null-mtime.js', null);

    const { results } = await hybrid.search('query', 1);
    expect(results[0].score).toBe(1);
  });

  it('should skip call graph boost if no symbols from top results', async () => {
    const vectorStore = [
      {
        file: 'no-symbols.js',
        content: '',
        vector: [1, 0],
        startLine: 1,
        endLine: 1,
      },
    ];
    const cache = createHybridSearchCacheStub({
      vectorStore,
      queryAnn: async () => null,
      getRelatedFiles: vi.fn(),
    });
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
    const cache = createHybridSearchCacheStub({
      vectorStore,
      queryAnn: async () => [0],
    });
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
      semanticWeight: 1,
      exactMatchBoost: 1,
      recencyBoost: 0,
      callGraphEnabled: false,
      callGraphBoost: 0,
      searchDirectory: '/mock',
    };
    const embedder = async () => ({ data: new Float32Array([1, 0]) });
    const hybrid = new HybridSearch(embedder, cache, config);

    const { results } = await hybrid.search('target', 2);
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe('match.js');
  });
});
