/**
 * Tests for HybridSearch feature
 *
 * Tests the search functionality including:
 * - Semantic search with embeddings
 * - Exact match boosting
 * - Result formatting
 * - Empty index handling
 * - Score calculation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  createTestFixtures,
  cleanupFixtures,
  clearTestCache,
  createMockRequest,
} from './helpers.js';
import * as HybridSearchFeature from '../features/hybrid-search.js';
import { HybridSearch } from '../features/hybrid-search.js';

describe('HybridSearch', () => {
  let fixtures;

  beforeAll(async () => {
    fixtures = await createTestFixtures({ workerThreads: 1, verbose: true });

    // Ensure we have indexed content
    await clearTestCache(fixtures.config);
    fixtures.cache.setVectorStore([]);
    fixtures.cache.clearFileHashes();
    await fixtures.indexer.indexAll(true);
  });

  afterAll(async () => {
    await cleanupFixtures(fixtures);
  });

  describe('Search Functionality', () => {
    it('should find relevant code for semantic queries', async () => {
      // Search for something that should exist in the codebase
      const { results, message } = await fixtures.hybridSearch.search('embedding model', 5);

      expect(message).toBeNull();
      expect(results.length).toBeGreaterThan(0);

      // Results should have required properties
      for (const result of results) {
        expect(result).toHaveProperty('file');
        expect(result).toHaveProperty('content');
        expect(result).toHaveProperty('score');
        expect(result).toHaveProperty('startLine');
        expect(result).toHaveProperty('endLine');
        expect(result).toHaveProperty('vector');
      }
    });

    it('should return results sorted by score (highest first)', async () => {
      const { results } = await fixtures.hybridSearch.search('function', 10);

      expect(results.length).toBeGreaterThan(1);

      // Verify descending order
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('should respect maxResults parameter', async () => {
      const maxResults = 3;
      const { results } = await fixtures.hybridSearch.search('const', maxResults);

      expect(results.length).toBeLessThanOrEqual(maxResults);
    });

    it('should boost exact matches', async () => {
      // Search for an exact term that exists
      const { results: exactResults } = await fixtures.hybridSearch.search('embedder', 5);

      // At least one result should contain the exact term
      const hasExactMatch = exactResults.some((r) => r.content.toLowerCase().includes('embedder'));

      expect(hasExactMatch).toBe(true);
    });

    it('should handle natural language queries', async () => {
      const { results } = await fixtures.hybridSearch.search(
        'where is the configuration loaded',
        5
      );

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('Empty Index Handling', () => {
    it('should return helpful message when index is empty', async () => {
      // Create a search instance with empty cache
      const emptyCache = {
        startRead: () => {},
        endRead: () => {},
        waitForReaders: async () => {},
        getVectorStore: () => [],
        setVectorStore: () => {},
        getFileHash: () => null,
        setFileHash: () => {},
        getStoreSize: () => 0,
        getVector: () => null,
        getChunk: () => null,
      };

      const emptySearch = new HybridSearch(fixtures.embedder, emptyCache, fixtures.config);
      const { results, message } = await emptySearch.search('test', 5);

      expect(results.length).toBe(0);
      expect(message).toContain('No code has been indexed');
    });
  });

  describe('Result Formatting', () => {
    it('should format results as markdown', async () => {
      const { results } = await fixtures.hybridSearch.search('function', 3);
      const formatted = await fixtures.hybridSearch.formatResults(results);

      // Should contain markdown elements
      expect(formatted).toContain('## Result');
      expect(formatted).toContain('**File:**');
      expect(formatted).toContain('**Lines:**');
      expect(formatted).toContain('```');
      expect(formatted).toContain('Relevance:');
    });

    it('should return no matches message for empty results', async () => {
      const formatted = await fixtures.hybridSearch.formatResults([]);

      expect(formatted).toContain('No matching code found');
    });

    it('should include relative file paths', async () => {
      const { results } = await fixtures.hybridSearch.search('export', 1);
      const formatted = await fixtures.hybridSearch.formatResults(results);

      // Should not contain absolute paths in the output
      expect(formatted).not.toContain(fixtures.config.searchDirectory);
    });
  });

  describe('Score Calculation', () => {
    it('should give higher scores to more relevant results', async () => {
      // Search for a specific term
      const { results } = await fixtures.hybridSearch.search('CodebaseIndexer', 5);

      if (results.length > 0) {
        // Top result should have high relevance
        expect(results[0].score).toBeGreaterThan(0.3);
      }
    });

    it('should apply semantic weight from config', async () => {
      const { results } = await fixtures.hybridSearch.search('async function', 5);

      // All results should have positive scores
      for (const result of results) {
        expect(result.score).toBeGreaterThan(0);
      }
    });
  });

  describe('ANN Candidate Handling', () => {
    it('should honor ANN min/max candidate settings', () => {
      const cache = {
        startRead: () => {},
        endRead: () => {},
        waitForReaders: async () => {},
        getVectorStore: () => [],
        queryAnn: async () => null,
        getRelatedFiles: async () => new Map(),
        getStoreSize: () => 0,
        getVector: () => null,
        getChunk: () => null,
      };
      const config = {
        annEnabled: true,
        annMinCandidates: 4,
        annMaxCandidates: 6,
        annCandidateMultiplier: 2,
        semanticWeight: 1,
        exactMatchBoost: 0,
        recencyBoost: 0,
        callGraphEnabled: false,
        callGraphBoost: 0,
        searchDirectory: process.cwd(),
      };
      const embedder = async () => ({ data: new Float32Array([1, 0]) });
      const hybrid = new HybridSearch(embedder, cache, config);

      expect(hybrid.getAnnCandidateCount(2, 10)).toBe(4);
    });

    it('should use default ANN candidate settings when unset', () => {
      const cache = {
        startRead: () => {},
        endRead: () => {},
        waitForReaders: async () => {},
        getVectorStore: () => [],
        queryAnn: async () => null,
        getRelatedFiles: async () => new Map(),
        getStoreSize: () => 0,
        getVector: () => null,
        getChunk: () => null,
      };
      const config = {
        annEnabled: true,
        semanticWeight: 1,
        exactMatchBoost: 0,
        recencyBoost: 0,
        callGraphEnabled: false,
        callGraphBoost: 0,
        searchDirectory: process.cwd(),
      };
      const embedder = async () => ({ data: new Float32Array([1, 0]) });
      const hybrid = new HybridSearch(embedder, cache, config);

      expect(hybrid.getAnnCandidateCount(5, 2)).toBe(2);
    });

    it('should dedupe ANN candidates and keep unique chunks', async () => {
      const vectorStore = [
        {
          file: 'a.js',
          content: 'alpha',
          vector: [1, 0],
          startLine: 1,
          endLine: 1,
        },
        {
          file: 'b.js',
          content: 'beta',
          vector: [0, 1],
          startLine: 1,
          endLine: 1,
        },
      ];
      const cache = {
        startRead: () => {},
        endRead: () => {},
        waitForReaders: async () => {},
        getVectorStore: () => vectorStore,
        queryAnn: async () => [0, 0, 1],
        getRelatedFiles: async () => new Map(),
        getStoreSize: () => vectorStore.length,
        getVector: (idx) => vectorStore[idx]?.vector,
        getChunk: (idx) => vectorStore[idx],
        getChunkContent: (idx) => vectorStore[idx]?.content,
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
        searchDirectory: process.cwd(),
      };
      const embedder = async () => ({ data: new Float32Array([1, 0]) });
      const hybrid = new HybridSearch(embedder, cache, config);

      const { results } = await hybrid.search('alpha', 2);

      const files = results.map((result) => result.file);
      expect(files).toContain('a.js');
      expect(files).toContain('b.js');
    });

    it('should fall back to full candidates when ANN returns too few', async () => {
      const vectorStore = [
        {
          file: 'a.js',
          content: 'alpha',
          vector: [1, 0],
          startLine: 1,
          endLine: 1,
        },
        {
          file: 'b.js',
          content: 'beta',
          vector: [0, 1],
          startLine: 1,
          endLine: 1,
        },
      ];
      const cache = {
        startRead: () => {},
        endRead: () => {},
        waitForReaders: async () => {},
        getVectorStore: () => vectorStore,
        queryAnn: async () => [0],
        getRelatedFiles: async () => new Map(),
        getStoreSize: () => vectorStore.length,
        getVector: (idx) => vectorStore[idx]?.vector,
        getChunk: (idx) => vectorStore[idx],
        getChunkContent: (idx) => vectorStore[idx]?.content,
      };
      const config = {
        annEnabled: true,
        annMinCandidates: 0,
        annMaxCandidates: 10,
        annCandidateMultiplier: 1,
        semanticWeight: 1,
        exactMatchBoost: 0,
        recencyBoost: 0,
        callGraphEnabled: false,
        callGraphBoost: 0,
        searchDirectory: process.cwd(),
      };
      const embedder = async () => ({ data: new Float32Array([1, 0]) });
      const hybrid = new HybridSearch(embedder, cache, config);

      const { results } = await hybrid.search('beta', 2);

      const files = results.map((result) => result.file);
      expect(files).toContain('b.js');
    });

    it('should fall back when ANN dedupe leaves too few results', async () => {
      const vectorStore = [
        {
          file: 'a.js',
          content: 'alpha',
          vector: [1, 0, 0],
          startLine: 1,
          endLine: 1,
        },
        {
          file: 'b.js',
          content: 'beta',
          vector: [0, 1, 0],
          startLine: 1,
          endLine: 1,
        },
        {
          file: 'c.js',
          content: 'gamma',
          vector: [0, 0, 1],
          startLine: 1,
          endLine: 1,
        },
      ];
      const cache = {
        startRead: () => {},
        endRead: () => {},
        waitForReaders: async () => {},
        getVectorStore: () => vectorStore,
        queryAnn: async () => [0, 0],
        getRelatedFiles: async () => new Map(),
        getStoreSize: () => vectorStore.length,
        getVector: (idx) => vectorStore[idx]?.vector,
        getChunk: (idx) => vectorStore[idx],
        getChunkContent: (idx) => vectorStore[idx]?.content,
      };
      const config = {
        annEnabled: true,
        annMinCandidates: 0,
        annMaxCandidates: 10,
        annCandidateMultiplier: 1,
        semanticWeight: 1,
        exactMatchBoost: 0,
        recencyBoost: 0,
        callGraphEnabled: false,
        callGraphBoost: 0,
        searchDirectory: process.cwd(),
      };
      const embedder = async () => ({ data: new Float32Array([0, 0, 1]) });
      const hybrid = new HybridSearch(embedder, cache, config);

      const { results } = await hybrid.search('gamma', 2);
      const files = results.map((result) => result.file);

      expect(files).toContain('c.js');
    });

    it('should add exact matches missed by ANN and avoid duplicates (lines 110, 113 coverage)', async () => {
      // Setup:
      // - 2 chunks in store, both are exact matches.
      // - ANN returns only the first one.
      // - maxResults = 2.
      //
      // Expected flow:
      // 1. ANN returns chunk 0. candidates = [chunk0].
      // 2. exactMatchCount = 1.
      // 3. exactMatchCount (1) < maxResults (2), so we enter the fallback block (line 110).
      // 4. We iterate over vectorStore.
      //    - Chunk 0 is already in 'seen', so we skip it (line 113 coverage).
      //    - Chunk 1 is not in 'seen', so we add it.
      const vectorStore = [
        {
          file: 'a.js',
          content: 'target match',
          vector: [1, 0],
          startLine: 1,
          endLine: 1,
        },
        {
          file: 'b.js',
          content: 'target match',
          vector: [0, 1],
          startLine: 1,
          endLine: 1,
        },
      ];
      const cache = {
        startRead: () => {},
        endRead: () => {},
        waitForReaders: async () => {},
        getVectorStore: () => vectorStore,
        queryAnn: async () => [0], // ANN only finds the first one
        getRelatedFiles: async () => new Map(),
        getStoreSize: () => vectorStore.length,
        getVector: (idx) => vectorStore[idx]?.vector,
        getChunk: (idx) => vectorStore[idx],
        getChunkContent: (idx) => vectorStore[idx]?.content,
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
        searchDirectory: process.cwd(),
      };
      const embedder = async () => ({ data: new Float32Array([1, 0]) });
      const hybrid = new HybridSearch(embedder, cache, config);

      const { results } = await hybrid.search('target', 2);

      expect(results).toHaveLength(2);
      const files = results.map((r) => r.file).sort();
      expect(files).toEqual(['a.js', 'b.js']);
    });

    it('should add exact-match chunks when ANN misses them', async () => {
      const vectorStore = [
        {
          file: 'a.js',
          content: 'alpha content',
          vector: [1, 0],
          startLine: 1,
          endLine: 1,
        },
        {
          file: 'b.js',
          content: 'exact match term',
          vector: [0, 1],
          startLine: 1,
          endLine: 1,
        },
      ];
      const cache = {
        startRead: () => {},
        endRead: () => {},
        waitForReaders: async () => {},
        getVectorStore: () => vectorStore,
        queryAnn: async () => [0],
        getRelatedFiles: async () => new Map(),
        getStoreSize: () => vectorStore.length,
        getVector: (idx) => vectorStore[idx]?.vector,
        getChunk: (idx) => vectorStore[idx],
        getChunkContent: (idx) => vectorStore[idx]?.content,
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
        searchDirectory: process.cwd(),
      };
      const embedder = async () => ({ data: new Float32Array([0, 1]) });
      const hybrid = new HybridSearch(embedder, cache, config);

      const { results } = await hybrid.search('exact', 1);

      expect(results[0].file).toBe('b.js');
    });

    it('should skip empty content and duplicate keys when adding exact matches', async () => {
      const vectorStore = [
        {
          file: 'a.js',
          content: 'no match here',
          vector: [1, 0],
          startLine: 1,
          endLine: 1,
        },
        {
          file: 'b.js',
          content: null,
          vector: [0, 1],
          startLine: 1,
          endLine: 1,
        },
        {
          file: 'a.js',
          content: 'match term',
          vector: [1, 0],
          startLine: 1,
          endLine: 1,
        },
      ];
      const cache = {
        startRead: () => {},
        endRead: () => {},
        waitForReaders: async () => {},
        getVectorStore: () => vectorStore,
        queryAnn: async () => [0],
        getRelatedFiles: async () => new Map(),
        getStoreSize: () => vectorStore.length,
        getVector: (idx) => vectorStore[idx]?.vector,
        getChunk: (idx) => vectorStore[idx],
        getChunkContent: (idx) => vectorStore[idx]?.content,
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
        searchDirectory: process.cwd(),
      };
      const embedder = async () => ({ data: new Float32Array([1, 0]) });
      const hybrid = new HybridSearch(embedder, cache, config);

      const { results } = await hybrid.search('match', 1);

      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('no match here');
    });
  });

  describe('Cache Invalidation', () => {
    it('should clear file modification times', () => {
      fixtures.hybridSearch.fileModTimes.set('a.js', 123);
      fixtures.hybridSearch.clearFileModTime('a.js');
      expect(fixtures.hybridSearch.fileModTimes.has('a.js')).toBe(false);
    });
  });

  describe('Recency Boost', () => {
    it('should apply recency boost using default decay days', async () => {
      const vectorStore = [
        {
          file: 'recent.js',
          content: 'recent',
          vector: [1, 0],
          startLine: 1,
          endLine: 1,
        },
      ];
      const cache = {
        startRead: () => {},
        endRead: () => {},
        waitForReaders: async () => {},
        getVectorStore: () => vectorStore,
        queryAnn: async () => null,
        getRelatedFiles: async () => new Map(),
        getStoreSize: () => vectorStore.length,
        getVector: (idx) => vectorStore[idx]?.vector,
        getChunk: (idx) => vectorStore[idx],
        getChunkContent: (idx) => vectorStore[idx]?.content,
      };
      const config = {
        annEnabled: false,
        semanticWeight: 1,
        exactMatchBoost: 0,
        recencyBoost: 0.5,
        recencyDecayDays: 0,
        callGraphEnabled: false,
        callGraphBoost: 0,
        searchDirectory: process.cwd(),
      };
      const embedder = async () => ({ data: new Float32Array([1, 0]) });
      const hybrid = new HybridSearch(embedder, cache, config);
      hybrid.fileModTimes.set('recent.js', Date.now());

      const { results } = await hybrid.search('recent', 1);

      expect(results[0].score).toBeCloseTo(1.5, 3);
    });

    it('should apply recency boost with custom decay days', async () => {
      const vectorStore = [
        {
          file: 'older.js',
          content: 'older',
          vector: [1, 0],
          startLine: 1,
          endLine: 1,
        },
      ];
      const cache = {
        startRead: () => {},
        endRead: () => {},
        waitForReaders: async () => {},
        getVectorStore: () => vectorStore,
        queryAnn: async () => null,
        getRelatedFiles: async () => new Map(),
        getStoreSize: () => vectorStore.length,
        getVector: (idx) => vectorStore[idx]?.vector,
        getChunk: (idx) => vectorStore[idx],
        getChunkContent: (idx) => vectorStore[idx]?.content,
      };
      const config = {
        annEnabled: false,
        semanticWeight: 1,
        exactMatchBoost: 0,
        recencyBoost: 0.5,
        recencyDecayDays: 10,
        callGraphEnabled: false,
        callGraphBoost: 0,
        searchDirectory: process.cwd(),
      };
      const embedder = async () => ({ data: new Float32Array([1, 0]) });
      const hybrid = new HybridSearch(embedder, cache, config);
      hybrid.fileModTimes.set('older.js', Date.now() - 5 * 24 * 60 * 60 * 1000);

      const { results } = await hybrid.search('older', 1);

      expect(results[0].score).toBeGreaterThan(1);
    });
  });
});

describe('Hybrid Search Tool Handler', () => {
  let fixtures;

  beforeAll(async () => {
    fixtures = await createTestFixtures({ workerThreads: 1 });

    // Ensure indexed content
    await fixtures.indexer.indexAll(false);
  });

  afterAll(async () => {
    await cleanupFixtures(fixtures);
  });

  describe('Tool Definition', () => {
    it('should have correct tool definition', () => {
      const toolDef = HybridSearchFeature.getToolDefinition(fixtures.config);

      expect(toolDef.name).toBe('a_semantic_search');
      expect(toolDef.description).toContain('semantic');
      expect(toolDef.description).toContain('hybrid');
      expect(toolDef.inputSchema.properties.query).toBeDefined();
      expect(toolDef.inputSchema.properties.maxResults).toBeDefined();
      expect(toolDef.inputSchema.required).toContain('query');
    });

    it('should use config default for maxResults', () => {
      const toolDef = HybridSearchFeature.getToolDefinition(fixtures.config);

      expect(toolDef.inputSchema.properties.maxResults.default).toBe(fixtures.config.maxResults);
    });
  });

  describe('Tool Handler', () => {
    it('should return search results for valid query', async () => {
      const request = createMockRequest('a_semantic_search', {
        query: 'function that handles indexing',
      });

      const result = await HybridSearchFeature.handleToolCall(request, fixtures.hybridSearch);

      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Result');
    });

    it('should use default maxResults when not provided', async () => {
      const request = createMockRequest('a_semantic_search', {
        query: 'import',
      });

      const result = await HybridSearchFeature.handleToolCall(request, fixtures.hybridSearch);

      // Should return results (up to default max)
      expect(result.content[0].text.length).toBeGreaterThan(0);
    });

    it('should respect custom maxResults', async () => {
      const request = createMockRequest('a_semantic_search', {
        query: 'const',
        maxResults: 2,
      });

      const result = await HybridSearchFeature.handleToolCall(request, fixtures.hybridSearch);

      // Count result headers
      const resultCount = (result.content[0].text.match(/## Result/g) || []).length;
      expect(resultCount).toBeLessThanOrEqual(2);
    });

    it('should handle queries with no matches gracefully', async () => {
      const request = createMockRequest('a_semantic_search', {
        query: 'xyzzy_nonexistent_symbol_12345',
      });

      const result = await HybridSearchFeature.handleToolCall(request, fixtures.hybridSearch);

      // Should return something (either no matches message or low-score results)
      expect(result.content[0].text.length).toBeGreaterThan(0);
    });

    it('should return message when no indexed data exists', async () => {
      const emptyCache = {
        startRead: () => {},
        endRead: () => {},
        waitForReaders: async () => {},
        getVectorStore: () => [],
        queryAnn: async () => null,
        getRelatedFiles: async () => new Map(),
        getStoreSize: () => 0,
        getVector: () => null,
        getChunk: () => null,
      };
      const emptySearch = new HybridSearch(fixtures.embedder, emptyCache, fixtures.config);
      const request = createMockRequest('a_semantic_search', {
        query: 'anything',
      });

      const result = await HybridSearchFeature.handleToolCall(request, emptySearch);

      expect(result.content[0].text).toContain('No code has been indexed');
    });
  });
});
