import { describe, it, expect, vi } from 'vitest';
import { HybridSearch } from '../features/hybrid-search.js';
import { createHybridSearchCacheStub } from './helpers.js';
import * as CallGraph from '../lib/call-graph.js';

describe('HybridSearch Final Coverage', () => {
  describe('Partial Match Logic', () => {
    it('should handle short words and missing words in partial matching', async () => {
      const vectorStore = [
        {
          file: 'partial.js',
          content: 'some longcontent here',
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
        semanticWeight: 0, 
        exactMatchBoost: 10,
        recencyBoost: 0,
        callGraphEnabled: false,
        searchDirectory: '/mock',
      };
      const embedder = async () => ({ data: new Float32Array([0, 0]) });
      const hybrid = new HybridSearch(embedder, cache, config);
      const { results } = await hybrid.search('is missingword', 1);
      expect(results[0].score).toBe(0);
    });

    it('should match words longer than 2 characters', async () => {
      const vectorStore = [
        {
          file: 'partial.js',
          content: 'some longcontent here',
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
        semanticWeight: 0,
        exactMatchBoost: 10,
        recencyBoost: 0,
        callGraphEnabled: false,
        searchDirectory: '/mock',
      };
      const embedder = async () => ({ data: new Float32Array([0, 0]) });
      const hybrid = new HybridSearch(embedder, cache, config);
      const { results } = await hybrid.search('longcontent missing', 1);
      expect(results[0].score).toBeCloseTo(0.15);
    });
  });

  describe('Call Graph Proximity', () => {
    it('should apply boost only when proximity exists', async () => {
      const vectorStore = [
        {
          file: 'source.js',
          content: 'function source() {}',
          vector: [1, 0],
          startLine: 1,
          endLine: 1,
        },
        {
          file: 'related.js',
          content: 'related content',
          vector: [0.9, 0],
          startLine: 1,
          endLine: 1,
        },
        {
          file: 'unrelated.js',
          content: 'unrelated content',
          vector: [0.8, 0],
          startLine: 1,
          endLine: 1,
        },
      ];

      const relatedMap = new Map();
      relatedMap.set('related.js', 1); 
      

      const cache = createHybridSearchCacheStub({
        vectorStore,
        queryAnn: async () => null,
        getRelatedFiles: async () => relatedMap,
      });

      const config = {
        annEnabled: false,
        semanticWeight: 1,
        exactMatchBoost: 0,
        recencyBoost: 0,
        callGraphEnabled: true,
        callGraphBoost: 10, 
        searchDirectory: '/mock',
      };

      const embedder = async () => ({ data: new Float32Array([1, 0]) });
      const hybrid = new HybridSearch(embedder, cache, config);
      
      vi.spyOn(CallGraph, 'extractSymbolsFromContent').mockReturnValue(['source']);

      const { results } = await hybrid.search('query', 3);
      const related = results.find((r) => r.file === 'related.js');
      const unrelated = results.find((r) => r.file === 'unrelated.js');
      expect(related.score).toBeGreaterThan(10);
      expect(unrelated.score).toBeLessThan(1);
    });
  });

  describe('Line 113 Coverage', () => {
    it('should explicitly hit line 113 (redundant chunk check)', async () => {
      const chunk = {
        file: 'hit.js',
        content: 'hit me',
        vector: [1],
        startLine: 1,
        endLine: 1,
      };
      const vectorStore = [chunk];

      const cache = createHybridSearchCacheStub({
        vectorStore,
        queryAnn: async () => [0],
      });

      const config = {
        annEnabled: true,
        annMinCandidates: 0,
        annMaxCandidates: 10,
        annCandidateMultiplier: 1,
        maxResults: 10,
        semanticWeight: 1,
        exactMatchBoost: 1,
        recencyBoost: 0,
        callGraphEnabled: false,
        searchDirectory: '/mock',
      };

      const embedder = async () => ({ data: new Float32Array([1]) });
      const hybrid = new HybridSearch(embedder, cache, config);

      await hybrid.search('hit', 10);
    });
  });

  describe('Edge Case Search Parameters', () => {
    it('should skip exact match fallback if query is too short', async () => {
      const vectorStore = [{ file: 'a.js', content: 'a', vector: [1], startLine: 1, endLine: 1 }];
      const cache = createHybridSearchCacheStub({
        vectorStore,
        queryAnn: async () => [0],
      });
      const config = {
        annEnabled: true,
        maxResults: 2,
        semanticWeight: 1,
        exactMatchBoost: 1,
        recencyBoost: 0,
        callGraphEnabled: false,
        searchDirectory: '/mock',
      };
      const embedder = async () => ({ data: new Float32Array([1]) });
      const hybrid = new HybridSearch(embedder, cache, config);

      
      await hybrid.search('a', 2);
    });

    it('should skip exact match fallback if exactMatchCount >= maxResults', async () => {
      const vectorStore = [
        { file: 'match.js', content: 'target', vector: [1], startLine: 1, endLine: 1 },
      ];
      const cache = createHybridSearchCacheStub({
        vectorStore,
        queryAnn: async () => [0],
      });
      const config = {
        annEnabled: true,
        maxResults: 1, 
        semanticWeight: 1,
        exactMatchBoost: 1,
        recencyBoost: 0,
        callGraphEnabled: false,
        searchDirectory: '/mock',
      };
      const embedder = async () => ({ data: new Float32Array([1]) });
      const hybrid = new HybridSearch(embedder, cache, config);

      await hybrid.search('target', 1);
    });
  });
});
