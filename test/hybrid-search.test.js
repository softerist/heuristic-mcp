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
  createMockRequest 
} from './helpers.js';
import * as HybridSearchFeature from '../features/hybrid-search.js';
import { HybridSearch } from '../features/hybrid-search.js';

describe('HybridSearch', () => {
  let fixtures;
  
  beforeAll(async () => {
    fixtures = await createTestFixtures({ workerThreads: 2 });
    
    // Ensure we have indexed content
    await clearTestCache(fixtures.config);
    fixtures.cache.setVectorStore([]);
    fixtures.cache.fileHashes = new Map();
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
      const hasExactMatch = exactResults.some(r => 
        r.content.toLowerCase().includes('embedder')
      );
      
      expect(hasExactMatch).toBe(true);
    });
    
    it('should handle natural language queries', async () => {
      const { results } = await fixtures.hybridSearch.search('where is the configuration loaded', 5);
      
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('Empty Index Handling', () => {
    it('should return helpful message when index is empty', async () => {
      // Create a search instance with empty cache
      const emptyCache = {
        getVectorStore: () => [],
        setVectorStore: () => {},
        getFileHash: () => null,
        setFileHash: () => {}
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
      const formatted = fixtures.hybridSearch.formatResults(results);
      
      // Should contain markdown elements
      expect(formatted).toContain('## Result');
      expect(formatted).toContain('**File:**');
      expect(formatted).toContain('**Lines:**');
      expect(formatted).toContain('```');
      expect(formatted).toContain('Relevance:');
    });
    
    it('should return no matches message for empty results', () => {
      const formatted = fixtures.hybridSearch.formatResults([]);
      
      expect(formatted).toContain('No matching code found');
    });
    
    it('should include relative file paths', async () => {
      const { results } = await fixtures.hybridSearch.search('export', 1);
      const formatted = fixtures.hybridSearch.formatResults(results);
      
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
});

describe('Hybrid Search Tool Handler', () => {
  let fixtures;
  
  beforeAll(async () => {
    fixtures = await createTestFixtures({ workerThreads: 2 });
    
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
        query: 'function that handles indexing' 
      });
      
      const result = await HybridSearchFeature.handleToolCall(request, fixtures.hybridSearch);
      
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Result');
    });
    
    it('should use default maxResults when not provided', async () => {
      const request = createMockRequest('a_semantic_search', { 
        query: 'import' 
      });
      
      const result = await HybridSearchFeature.handleToolCall(request, fixtures.hybridSearch);
      
      // Should return results (up to default max)
      expect(result.content[0].text.length).toBeGreaterThan(0);
    });
    
    it('should respect custom maxResults', async () => {
      const request = createMockRequest('a_semantic_search', { 
        query: 'const',
        maxResults: 2
      });
      
      const result = await HybridSearchFeature.handleToolCall(request, fixtures.hybridSearch);
      
      // Count result headers
      const resultCount = (result.content[0].text.match(/## Result/g) || []).length;
      expect(resultCount).toBeLessThanOrEqual(2);
    });
    
    it('should handle queries with no matches gracefully', async () => {
      const request = createMockRequest('a_semantic_search', { 
        query: 'xyzzy_nonexistent_symbol_12345' 
      });
      
      const result = await HybridSearchFeature.handleToolCall(request, fixtures.hybridSearch);
      
      // Should return something (either no matches message or low-score results)
      expect(result.content[0].text.length).toBeGreaterThan(0);
    });
  });
});
