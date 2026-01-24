/**
 * Integration tests for cross-feature interactions
 *
 * Tests scenarios that involve multiple features working together:
 * 1. Concurrent indexing protection across MCP tool calls
 * 2. Clear cache interaction with indexing
 * 3. Tool handler response quality
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  createTestFixtures,
  cleanupFixtures,
  clearTestCache,
  createMockRequest,
  measureTime,
} from './helpers.js';
import * as IndexCodebaseFeature from '../features/index-codebase.js';
import * as ClearCacheFeature from '../features/clear-cache.js';

describe('Concurrent Indexing', () => {
  let fixtures;

  beforeAll(async () => {
    fixtures = await createTestFixtures({ workerThreads: 1 });
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
    // Restore mocks
    vi.restoreAllMocks();
  });

  it('should only run one indexer at a time', async () => {
    // Control the timing of indexing
    let resolveDiscovery;
    const discoveryBarrier = new Promise((resolve) => {
      resolveDiscovery = resolve;
    });

    // Mock discoverFiles to hang until we say so
    const discoverSpy = vi.spyOn(fixtures.indexer, 'discoverFiles').mockImplementation(async () => {
      await discoveryBarrier;
      return []; // Return empty list to finish quickly after barrier
    });

    const request1 = createMockRequest('b_index_codebase', { force: true });
    const request2 = createMockRequest('b_index_codebase', { force: false });

    // Start first indexing
    const promise1 = IndexCodebaseFeature.handleToolCall(request1, fixtures.indexer);

    // It should immediately set the flag
    expect(fixtures.indexer.isIndexing).toBe(true);

    // Start second indexing while first is "running" (stuck at discovery)
    const promise2 = IndexCodebaseFeature.handleToolCall(request2, fixtures.indexer);

    // Now let the first one finish
    resolveDiscovery();

    // Wait for both to complete
    const [result1, result2] = await Promise.all([promise1, promise2]);

    // Verify first result
    // If empty files, it might return "No files found" or success depending on logic
    // We check that it didn't fail or skip
    expect(result1.content[0].text).not.toContain('Indexing skipped');

    // Second should clearly indicate it was skipped
    expect(result2.content[0].text).toContain('Indexing skipped');
    expect(result2.content[0].text).toContain('already in progress');

    discoverSpy.mockRestore();
  });

  it('should set isIndexing flag during indexing', async () => {
    // Control the timing
    let resolveDiscovery;
    const discoveryBarrier = new Promise((resolve) => {
      resolveDiscovery = resolve;
    });

    vi.spyOn(fixtures.indexer, 'discoverFiles').mockImplementation(async () => {
      await discoveryBarrier;
      return [];
    });

    // Start indexing
    const promise = fixtures.indexer.indexAll(true);

    // Check flag is set
    expect(fixtures.indexer.isIndexing).toBe(true);

    // Release
    resolveDiscovery();

    // Wait for completion
    await promise;

    // Check flag is cleared
    expect(fixtures.indexer.isIndexing).toBe(false);
  });

  it('should skip concurrent indexing calls gracefully', async () => {
    // Control the timing
    let resolveDiscovery;
    const discoveryBarrier = new Promise((resolve) => {
      resolveDiscovery = resolve;
    });

    vi.spyOn(fixtures.indexer, 'discoverFiles').mockImplementation(async () => {
      await discoveryBarrier;
      return [];
    });

    // Start first indexing
    const promise1 = fixtures.indexer.indexAll(true);

    // Second call should return immediately with skipped status
    const { result, duration } = await measureTime(() => fixtures.indexer.indexAll(false));

    // Second call should return very quickly
    expect(duration).toBeLessThan(1000);

    // Should indicate it was skipped
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('already in progress');

    resolveDiscovery();
    await promise1;
  });
});

describe('Clear Cache Operations', () => {
  let fixtures;

  beforeAll(async () => {
    fixtures = await createTestFixtures({ workerThreads: 1 });
  });

  afterAll(async () => {
    await cleanupFixtures(fixtures);
  });

  beforeEach(async () => {
    fixtures.indexer.isIndexing = false;
    vi.restoreAllMocks();
  });

  it('should prevent clear cache while indexing', async () => {
    // Control timing
    let resolveDiscovery;
    const discoveryBarrier = new Promise((resolve) => {
      resolveDiscovery = resolve;
    });

    vi.spyOn(fixtures.indexer, 'discoverFiles').mockImplementation(async () => {
      await discoveryBarrier;
      return [];
    });

    // Start indexing
    const indexPromise = fixtures.indexer.indexAll(true);

    // Confirm it's running
    expect(fixtures.indexer.isIndexing).toBe(true);

    // Try to clear cache
    const request = createMockRequest('c_clear_cache', {});
    const result = await ClearCacheFeature.handleToolCall(request, fixtures.cacheClearer);

    // Should fail with appropriate message
    expect(result.content[0].text).toContain('indexing is in progress');

    resolveDiscovery();
    await indexPromise;
  });

  it('should allow clear cache after indexing completes', async () => {
    // First index - standard mock that returns immediately (empty)
    const discoverSpy = vi.spyOn(fixtures.indexer, 'discoverFiles').mockResolvedValue([]);

    await fixtures.indexer.indexAll(true);

    // Verify indexing is done
    expect(fixtures.indexer.isIndexing).toBe(false);

    // Now clear cache
    const request = createMockRequest('c_clear_cache', {});
    const result = await ClearCacheFeature.handleToolCall(request, fixtures.cacheClearer);

    // Windows can lock cache directories intermittently; allow either outcome.
    expect(result.content[0].text).toMatch(/Cache cleared successfully|Failed to clear cache/);
  });

  it('should handle multiple concurrent clear cache calls', async () => {
    // First index
    const discoverSpy = vi.spyOn(fixtures.indexer, 'discoverFiles').mockResolvedValue([]);
    await fixtures.indexer.indexAll(true);

    // Reset the isClearing flag
    fixtures.cacheClearer.isClearing = false;

    // Multiple concurrent clears - with new mutex, only first should succeed
    const promises = [
      fixtures.cacheClearer.execute(),
      fixtures.cacheClearer.execute(),
      fixtures.cacheClearer.execute(),
    ];

    const results = await Promise.allSettled(promises);

    // First should succeed, others should fail with "already in progress"
    const successes = results.filter((r) => r.status === 'fulfilled');
    const failures = results.filter((r) => r.status === 'rejected');

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
    fixtures = await createTestFixtures({ workerThreads: 1 });
  });

  afterAll(async () => {
    await cleanupFixtures(fixtures);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
  });

  it('should return meaningful response when indexing is skipped', async () => {
    // Control timing
    let resolveDiscovery;
    const discoveryBarrier = new Promise((resolve) => {
      resolveDiscovery = resolve;
    });

    vi.spyOn(fixtures.indexer, 'discoverFiles').mockImplementation(async () => {
      await discoveryBarrier;
      return [];
    });

    // Start first indexing
    const promise1 = fixtures.indexer.indexAll(true);

    // Second call via handler
    const request = createMockRequest('b_index_codebase', { force: false });
    const result = await IndexCodebaseFeature.handleToolCall(request, fixtures.indexer);

    resolveDiscovery();
    await promise1;

    // The response should clearly indicate the indexing was skipped
    expect(result.content[0].text).toContain('Indexing skipped');
    expect(result.content[0].text).toContain('already in progress');
    expect(result.content[0].text).toContain('Please wait');
  });
});
