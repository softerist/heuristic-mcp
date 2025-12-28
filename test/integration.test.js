/**
 * Integration tests for cross-feature interactions
 * 
 * Tests scenarios that involve multiple features working together:
 * 1. Concurrent indexing protection across MCP tool calls
 * 2. Clear cache interaction with indexing
 * 3. Tool handler response quality
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
import * as ClearCacheFeature from '../features/clear-cache.js';

describe('Concurrent Indexing', () => {
  let fixtures;
  
  beforeAll(async () => {
    fixtures = await createTestFixtures({ workerThreads: 2 });
  });
  
  afterAll(async () => {
    await cleanupFixtures(fixtures);
  });
  
  beforeEach(async () => {
    // Reset indexing state
    fixtures.indexer.isIndexing = false;
    // Clear cache for clean state
    await clearTestCache(fixtures.config);
    fixtures.cache.setVectorStore([]);
    fixtures.cache.fileHashes = new Map();
  });
  
  it('should only run one indexer at a time', async () => {
    const request1 = createMockRequest('b_index_codebase', { force: true });
    const request2 = createMockRequest('b_index_codebase', { force: false });
    
    // Start first indexing
    const promise1 = IndexCodebaseFeature.handleToolCall(request1, fixtures.indexer);
    
    // Wait a bit for first to start
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify first is running
    expect(fixtures.indexer.isIndexing).toBe(true);
    
    // Start second indexing while first is running
    const promise2 = IndexCodebaseFeature.handleToolCall(request2, fixtures.indexer);
    
    // Wait for both to complete
    const [result1, result2] = await Promise.all([promise1, promise2]);
    
    // First should complete with stats
    expect(result1.content[0].text).toContain('reindexed successfully');
    expect(result1.content[0].text).toContain('Total files in index');
    
    // Second should clearly indicate it was skipped
    expect(result2.content[0].text).toContain('Indexing skipped');
    expect(result2.content[0].text).toContain('already in progress');
  });
  
  it('should set isIndexing flag during indexing', async () => {
    // Check initial state
    expect(fixtures.indexer.isIndexing).toBe(false);
    
    // Start indexing
    const promise = fixtures.indexer.indexAll(true);
    
    // Wait for it to start
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Check flag is set
    expect(fixtures.indexer.isIndexing).toBe(true);
    
    // Wait for completion
    await promise;
    
    // Check flag is cleared
    expect(fixtures.indexer.isIndexing).toBe(false);
  });
  
  it('should skip concurrent indexing calls gracefully', async () => {
    // Start first indexing
    const promise1 = fixtures.indexer.indexAll(true);
    
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Second call should return immediately with skipped status
    const { result, duration } = await measureTime(() => fixtures.indexer.indexAll(false));
    
    // Second call should return very quickly (not run full indexing)
    expect(duration).toBeLessThan(100);
    
    // Should indicate it was skipped
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('already in progress');
    
    await promise1;
  });
});

describe('Clear Cache Operations', () => {
  let fixtures;
  
  beforeAll(async () => {
    fixtures = await createTestFixtures({ workerThreads: 2 });
  });
  
  afterAll(async () => {
    await cleanupFixtures(fixtures);
  });
  
  beforeEach(async () => {
    fixtures.indexer.isIndexing = false;
  });
  
  it('should prevent clear cache while indexing', async () => {
    // Start indexing
    const indexPromise = fixtures.indexer.indexAll(true);
    
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Try to clear cache
    const request = createMockRequest('c_clear_cache', {});
    const result = await ClearCacheFeature.handleToolCall(request, fixtures.cacheClearer);
    
    // Should fail with appropriate message
    expect(result.content[0].text).toContain('indexing is in progress');
    
    await indexPromise;
  });
  
  it('should allow clear cache after indexing completes', async () => {
    // First index
    await fixtures.indexer.indexAll(true);
    
    // Verify indexing is done
    expect(fixtures.indexer.isIndexing).toBe(false);
    
    // Now clear cache
    const request = createMockRequest('c_clear_cache', {});
    const result = await ClearCacheFeature.handleToolCall(request, fixtures.cacheClearer);
    
    // Should succeed
    expect(result.content[0].text).toContain('Cache cleared successfully');
  });
  
  it('should clear cache immediately after indexing without crash', async () => {
    // This tests the race condition scenario
    await fixtures.indexer.indexAll(true);
    
    // Immediately clear (potential race with cache.save())
    const result = await fixtures.cacheClearer.execute();
    
    expect(result.success).toBe(true);
    expect(result.message).toContain('Cache cleared successfully');
  });
  
  it('should handle multiple concurrent clear cache calls', async () => {
    // First index to have something to clear
    await fixtures.indexer.indexAll(true);
    
    // Reset the isClearing flag
    fixtures.cacheClearer.isClearing = false;
    
    // Multiple concurrent clears - with new mutex, only first should succeed
    const promises = [
      fixtures.cacheClearer.execute(),
      fixtures.cacheClearer.execute(),
      fixtures.cacheClearer.execute()
    ];
    
    const results = await Promise.allSettled(promises);
    
    // First should succeed, others should fail with "already in progress"
    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');
    
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(2);
    
    // Verify failure message
    for (const failure of failures) {
      expect(failure.reason.message).toContain('already in progress');
    }
  });
});

describe('Tool Handler Response Quality', () => {
  let fixtures;
  
  beforeAll(async () => {
    fixtures = await createTestFixtures({ workerThreads: 2 });
  });
  
  afterAll(async () => {
    await cleanupFixtures(fixtures);
  });
  
  it('should return meaningful response when indexing is skipped', async () => {
    // Start first indexing
    const promise1 = fixtures.indexer.indexAll(true);
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Second call via handler
    const request = createMockRequest('b_index_codebase', { force: false });
    const result = await IndexCodebaseFeature.handleToolCall(request, fixtures.indexer);
    
    await promise1;
    
    // The response should clearly indicate the indexing was skipped
    expect(result.content[0].text).toContain('Indexing skipped');
    expect(result.content[0].text).toContain('already in progress');
    expect(result.content[0].text).toContain('Please wait');
  });
});
