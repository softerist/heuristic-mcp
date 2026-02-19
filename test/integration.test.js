

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
    
    fixtures.indexer.isIndexing = false;
    
    await clearTestCache(fixtures.config);
    fixtures.cache.setVectorStore([]);
    fixtures.cache.clearFileHashes();
    
    vi.restoreAllMocks();
  });

  it('should only run one indexer at a time', async () => {
    
    let resolveDiscovery;
    const discoveryBarrier = new Promise((resolve) => {
      resolveDiscovery = resolve;
    });

    
    const discoverSpy = vi.spyOn(fixtures.indexer, 'discoverFiles').mockImplementation(async () => {
      await discoveryBarrier;
      return []; 
    });

    const request1 = createMockRequest('b_index_codebase', { force: true });
    const request2 = createMockRequest('b_index_codebase', { force: false });

    
    const promise1 = IndexCodebaseFeature.handleToolCall(request1, fixtures.indexer);

    
    expect(fixtures.indexer.isIndexing).toBe(true);

    
    const promise2 = IndexCodebaseFeature.handleToolCall(request2, fixtures.indexer);

    
    resolveDiscovery();

    
    const [result1, result2] = await Promise.all([promise1, promise2]);

    
    
    
    expect(result1.content[0].text).not.toContain('Indexing skipped');

    
    expect(result2.content[0].text).toContain('Indexing skipped');
    expect(result2.content[0].text).toContain('already in progress');

    discoverSpy.mockRestore();
  });

  it('should set isIndexing flag during indexing', async () => {
    
    let resolveDiscovery;
    const discoveryBarrier = new Promise((resolve) => {
      resolveDiscovery = resolve;
    });

    vi.spyOn(fixtures.indexer, 'discoverFiles').mockImplementation(async () => {
      await discoveryBarrier;
      return [];
    });

    
    const promise = fixtures.indexer.indexAll(true);

    
    expect(fixtures.indexer.isIndexing).toBe(true);

    
    resolveDiscovery();

    
    await promise;

    
    expect(fixtures.indexer.isIndexing).toBe(false);
  });

  it('should skip concurrent indexing calls gracefully', async () => {
    
    let resolveDiscovery;
    const discoveryBarrier = new Promise((resolve) => {
      resolveDiscovery = resolve;
    });

    vi.spyOn(fixtures.indexer, 'discoverFiles').mockImplementation(async () => {
      await discoveryBarrier;
      return [];
    });

    
    const promise1 = fixtures.indexer.indexAll(true);

    
    const { result, duration } = await measureTime(() => fixtures.indexer.indexAll(false));

    
    expect(duration).toBeLessThan(1000);

    
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
    
    let resolveDiscovery;
    const discoveryBarrier = new Promise((resolve) => {
      resolveDiscovery = resolve;
    });

    vi.spyOn(fixtures.indexer, 'discoverFiles').mockImplementation(async () => {
      await discoveryBarrier;
      return [];
    });

    
    const indexPromise = fixtures.indexer.indexAll(true);

    
    expect(fixtures.indexer.isIndexing).toBe(true);

    
    const request = createMockRequest('c_clear_cache', {});
    const result = await ClearCacheFeature.handleToolCall(request, fixtures.cacheClearer);

    
    expect(result.content[0].text).toContain('indexing is in progress');

    resolveDiscovery();
    await indexPromise;
  });

  it('should allow clear cache after indexing completes', async () => {
    
    const discoverSpy = vi.spyOn(fixtures.indexer, 'discoverFiles').mockResolvedValue([]);

    await fixtures.indexer.indexAll(true);

    
    expect(fixtures.indexer.isIndexing).toBe(false);

    
    const request = createMockRequest('c_clear_cache', {});
    const result = await ClearCacheFeature.handleToolCall(request, fixtures.cacheClearer);

    
    expect(result.content[0].text).toMatch(/Cache cleared successfully|Failed to clear cache/);
  });

  it('should handle multiple concurrent clear cache calls', async () => {
    
    const discoverSpy = vi.spyOn(fixtures.indexer, 'discoverFiles').mockResolvedValue([]);
    await fixtures.indexer.indexAll(true);

    
    fixtures.cacheClearer.isClearing = false;

    
    const promises = [
      fixtures.cacheClearer.execute(),
      fixtures.cacheClearer.execute(),
      fixtures.cacheClearer.execute(),
    ];

    const results = await Promise.allSettled(promises);

    
    const successes = results.filter((r) => r.status === 'fulfilled');
    const failures = results.filter((r) => r.status === 'rejected');

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(2);

    
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
    
    let resolveDiscovery;
    const discoveryBarrier = new Promise((resolve) => {
      resolveDiscovery = resolve;
    });

    vi.spyOn(fixtures.indexer, 'discoverFiles').mockImplementation(async () => {
      await discoveryBarrier;
      return [];
    });

    
    const promise1 = fixtures.indexer.indexAll(true);

    
    const request = createMockRequest('b_index_codebase', { force: false });
    const result = await IndexCodebaseFeature.handleToolCall(request, fixtures.indexer);

    resolveDiscovery();
    await promise1;

    
    expect(result.content[0].text).toContain('Indexing skipped');
    expect(result.content[0].text).toContain('already in progress');
    expect(result.content[0].text).toContain('Please wait');
  });
});
