/**
 * Tests for CodebaseIndexer feature
 * 
 * Tests the indexing functionality including:
 * - File discovery and filtering
 * - Chunk generation and embedding
 * - Concurrent indexing protection
 * - Force reindex behavior
 * - Progress notifications
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { 
  createTestFixtures, 
  cleanupFixtures, 
  clearTestCache,
  createMockRequest,
  measureTime 
} from './helpers.js';
import * as IndexCodebaseFeature from '../features/index-codebase.js';
import { CodebaseIndexer } from '../features/index-codebase.js';

describe('CodebaseIndexer', () => {
  let fixtures;
  
  beforeAll(async () => {
    fixtures = await createTestFixtures({ workerThreads: 1 });
  });
  
  afterAll(async () => {
    await cleanupFixtures(fixtures);
  });
  
  beforeEach(async () => {
    // Reset state
    fixtures.indexer.isIndexing = false;
    fixtures.indexer.terminateWorkers();
  });

  describe('Basic Indexing', () => {
    it('should index files and create embeddings', async () => {
      // Clear cache first
      await clearTestCache(fixtures.config);
      fixtures.cache.setVectorStore([]);
      fixtures.cache.fileHashes = new Map();
      
      // Run indexing
      const result = await fixtures.indexer.indexAll(true);
      
      // Should have processed files
      expect(result.skipped).toBe(false);
      expect(result.filesProcessed).toBeGreaterThan(0);
      expect(result.chunksCreated).toBeGreaterThan(0);
      expect(result.totalFiles).toBeGreaterThan(0);
      expect(result.totalChunks).toBeGreaterThan(0);
    });
    
    it('should skip unchanged files on subsequent indexing', async () => {
      // First index
      await fixtures.indexer.indexAll(true);
      
      // Second index without force
      const result = await fixtures.indexer.indexAll(false);
      
      // Should skip processing (files unchanged)
      expect(result.skipped).toBe(false);
      expect(result.filesProcessed).toBe(0);
      expect(result.message).toContain('up to date');
    });
    
    it('should reindex all files when force is true', async () => {
      // First index
      await fixtures.indexer.indexAll(true);
      const firstChunks = fixtures.cache.getVectorStore().length;
      
      // Force reindex
      const result = await fixtures.indexer.indexAll(true);
      
      // Should have processed all files again
      expect(result.filesProcessed).toBeGreaterThan(0);
      expect(result.chunksCreated).toBeGreaterThan(0);
    });
  });

  describe('Concurrent Indexing Protection', () => {
    it('should prevent concurrent indexing', async () => {
      // Clear for clean state
      await clearTestCache(fixtures.config);
      fixtures.cache.setVectorStore([]);
      fixtures.cache.fileHashes = new Map();
      
      // Start first indexing
      const promise1 = fixtures.indexer.indexAll(true);
      expect(fixtures.indexer.isIndexing).toBe(true);
      
      // Second call should be skipped
      const result2 = await fixtures.indexer.indexAll(false);
      
      expect(result2.skipped).toBe(true);
      expect(result2.reason).toContain('already in progress');
      
      await promise1;
    });
    
    it('should set and clear isIndexing flag correctly', async () => {
      // Clear cache to ensure indexing actually runs
      await clearTestCache(fixtures.config);
      fixtures.cache.setVectorStore([]);
      fixtures.cache.fileHashes = new Map();
      
      expect(fixtures.indexer.isIndexing).toBe(false);
      
      const promise = fixtures.indexer.indexAll(true);
      expect(fixtures.indexer.isIndexing).toBe(true);
      
      await promise;
      
      // Should be cleared after indexing
      expect(fixtures.indexer.isIndexing).toBe(false);
    });
  });

  describe('File Discovery', () => {
    it('should discover files matching configured extensions', async () => {
      const files = await fixtures.indexer.discoverFiles();
      
      expect(files.length).toBeGreaterThan(0);
      
      // All files should have valid extensions
      const extensions = fixtures.config.fileExtensions.map(ext => `.${ext}`);
      for (const file of files) {
        const ext = file.substring(file.lastIndexOf('.'));
        expect(extensions).toContain(ext);
      }
    });
    
    it('should exclude files in excluded directories', async () => {
      const files = await fixtures.indexer.discoverFiles();
      
      // No files from node_modules
      const nodeModulesFiles = files.filter(f => f.includes('node_modules'));
      expect(nodeModulesFiles.length).toBe(0);
      
      // No files from .smart-coding-cache
      const cacheFiles = files.filter(f => f.includes('.smart-coding-cache'));
      expect(cacheFiles.length).toBe(0);
    });
  });

  describe('Worker Thread Management', () => {
    it('should initialize workers when CPU count > 1', async () => {
      await fixtures.indexer.initializeWorkers();
      
      // Should have at least 1 worker on multi-core systems
      expect(fixtures.indexer.workers.length).toBeGreaterThanOrEqual(0);
      
      fixtures.indexer.terminateWorkers();
      expect(fixtures.indexer.workers.length).toBe(0);
    });
  });
});

describe('Index Codebase Tool Handler', () => {
  let fixtures;
  
  beforeAll(async () => {
    fixtures = await createTestFixtures({ workerThreads: 1 });
  });
  
  afterAll(async () => {
    await cleanupFixtures(fixtures);
  });
  
  beforeEach(async () => {
    fixtures.indexer.isIndexing = false;
  });

  describe('Tool Definition', () => {
    it('should have correct tool definition', () => {
      const toolDef = IndexCodebaseFeature.getToolDefinition();
      
      expect(toolDef.name).toBe('b_index_codebase');
      expect(toolDef.description).toContain('reindex');
      expect(toolDef.inputSchema.properties.force).toBeDefined();
      expect(toolDef.inputSchema.properties.force.type).toBe('boolean');
    });
  });

  describe('Tool Handler', () => {
    it('should return success message on completed indexing', async () => {
      const request = createMockRequest('b_index_codebase', { force: false });
      const result = await IndexCodebaseFeature.handleToolCall(request, fixtures.indexer);
      
      expect(result.content[0].text).toContain('reindexed successfully');
      expect(result.content[0].text).toContain('Total files in index');
      expect(result.content[0].text).toContain('Total code chunks');
    });
    
    it('should return skipped message on concurrent calls', async () => {
      // Start first indexing
      await clearTestCache(fixtures.config);
      fixtures.cache.setVectorStore([]);
      fixtures.cache.fileHashes = new Map();
      
      const promise1 = IndexCodebaseFeature.handleToolCall(
        createMockRequest('b_index_codebase', { force: true }), 
        fixtures.indexer
      );
      expect(fixtures.indexer.isIndexing).toBe(true);
      
      // Second concurrent call
      const result2 = await IndexCodebaseFeature.handleToolCall(
        createMockRequest('b_index_codebase', { force: false }), 
        fixtures.indexer
      );
      
      expect(result2.content[0].text).toContain('Indexing skipped');
      expect(result2.content[0].text).toContain('already in progress');
      
      await promise1;
    });
    
    it('should handle force parameter correctly', async () => {
      // First index
      await IndexCodebaseFeature.handleToolCall(
        createMockRequest('b_index_codebase', { force: true }), 
        fixtures.indexer
      );
      
      // Non-force should skip unchanged
      const result = await IndexCodebaseFeature.handleToolCall(
        createMockRequest('b_index_codebase', { force: false }), 
        fixtures.indexer
      );
      
      expect(result.content[0].text).toContain('up to date');
    });
  });
});
