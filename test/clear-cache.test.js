/**
 * Tests for CacheClearer feature
 *
 * Tests the cache clearing functionality including:
 * - Basic cache clearing
 * - Protection during indexing
 * - Protection during save operations
 * - Concurrent clear prevention
 * - Tool handler responses
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  createTestFixtures,
  cleanupFixtures,
  clearTestCache,
  createMockRequest,
} from './helpers.js';
import * as ClearCacheFeature from '../features/clear-cache.js';
import { CacheClearer } from '../features/clear-cache.js';
import fs from 'fs/promises';

describe('CacheClearer', () => {
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
    fixtures.cache.isSaving = false;
    fixtures.cacheClearer.isClearing = false;
  });

  describe('Basic Cache Clearing', () => {
    it('should clear cache successfully', async () => {
      expect(fixtures.cacheClearer).toBeInstanceOf(CacheClearer);

      // First ensure we have a cache
      await fixtures.indexer.indexAll(true);

      // Verify cache exists
      expect(fixtures.cache.getVectorStore().length).toBeGreaterThan(0);

      // Clear cache
      const result = await fixtures.cacheClearer.execute();

      expect(result.success).toBe(true);
      expect(result.message).toContain('Cache cleared successfully');
      expect(result.cacheDirectory).toBe(fixtures.config.cacheDirectory);
    });

    it('should empty vectorStore and fileHashes', async () => {
      // Create some cache
      await fixtures.indexer.indexAll(true);

      // Clear
      await fixtures.cacheClearer.execute();

      // Both should be empty
      expect(fixtures.cache.getVectorStore().length).toBe(0);
      expect(fixtures.cache.getFileHashCount()).toBe(0);
    });

    it('should delete cache directory', async () => {
      // Create cache
      await fixtures.indexer.indexAll(true);

      // Verify cache directory exists
      await expect(fs.access(fixtures.config.cacheDirectory)).resolves.not.toThrow();

      // Clear
      await fixtures.cacheClearer.execute();

      // Directory should not exist
      await expect(fs.access(fixtures.config.cacheDirectory)).rejects.toThrow();
    });
  });

  describe('Protection During Indexing', () => {
    it('should prevent clear while indexing is in progress', async () => {
      // Simulate indexing in progress
      await clearTestCache(fixtures.config);
      fixtures.cache.setVectorStore([]);
      fixtures.cache.clearFileHashes();

      const indexPromise = fixtures.indexer.indexAll(true);
      expect(fixtures.indexer.isIndexing).toBe(true);

      // Try to clear - should fail
      await expect(fixtures.cacheClearer.execute()).rejects.toThrow(
        'Cannot clear cache while indexing is in progress'
      );

      await indexPromise;
    });

    it('should allow clear after indexing completes', async () => {
      // Complete indexing
      await fixtures.indexer.indexAll(true);
      expect(fixtures.indexer.isIndexing).toBe(false);

      // Clear should work
      const result = await fixtures.cacheClearer.execute();
      expect(result.success).toBe(true);
    });
  });

  describe('Protection During Save', () => {
    it('should prevent clear while cache is being saved', async () => {
      // Simulate save in progress
      fixtures.cache.isSaving = true;

      // Try to clear - should fail
      await expect(fixtures.cacheClearer.execute()).rejects.toThrow(
        'Cannot clear cache while cache is being saved'
      );

      // Reset
      fixtures.cache.isSaving = false;
    });

    it('should allow clear after save completes', async () => {
      // Index first
      await fixtures.indexer.indexAll(true);

      // isSaving should be false after indexing
      expect(fixtures.cache.isSaving).toBe(false);

      // Clear should work
      const result = await fixtures.cacheClearer.execute();
      expect(result.success).toBe(true);
    });
  });

  describe('Concurrent Clear Prevention', () => {
    it('should prevent multiple concurrent clears', async () => {
      // Index first
      await fixtures.indexer.indexAll(true);

      // Reset the isClearing flag
      fixtures.cacheClearer.isClearing = false;

      // Start multiple concurrent clears
      const promises = [
        fixtures.cacheClearer.execute(),
        fixtures.cacheClearer.execute(),
        fixtures.cacheClearer.execute(),
      ];

      const results = await Promise.allSettled(promises);

      // Exactly one should succeed
      const successes = results.filter((r) => r.status === 'fulfilled');
      const failures = results.filter((r) => r.status === 'rejected');

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(2);

      // Failures should have correct error message
      for (const failure of failures) {
        expect(failure.reason.message).toContain('already in progress');
      }
    });

    it('should reset isClearing flag after completion', async () => {
      // Index first
      await fixtures.indexer.indexAll(true);

      expect(fixtures.cacheClearer.isClearing).toBe(false);

      // Clear
      await fixtures.cacheClearer.execute();

      // Flag should be reset
      expect(fixtures.cacheClearer.isClearing).toBe(false);
    });

    it('should reset isClearing flag even on error', async () => {
      // Set up for failure
      fixtures.cache.isSaving = true;

      try {
        await fixtures.cacheClearer.execute();
      } catch {
        // Expected to fail
      }

      // isClearing should not have been set (failed before setting)
      expect(fixtures.cacheClearer.isClearing).toBe(false);

      // Reset
      fixtures.cache.isSaving = false;
    });
  });
});

describe('Clear Cache Tool Handler', () => {
  let fixtures;

  beforeAll(async () => {
    fixtures = await createTestFixtures({ workerThreads: 1 });
  });

  afterAll(async () => {
    await cleanupFixtures(fixtures);
  });

  beforeEach(async () => {
    fixtures.indexer.isIndexing = false;
    fixtures.cache.isSaving = false;
    fixtures.cacheClearer.isClearing = false;
  });

  describe('Tool Definition', () => {
    it('should have correct tool definition', () => {
      const toolDef = ClearCacheFeature.getToolDefinition();

      expect(toolDef.name).toBe('c_clear_cache');
      expect(toolDef.description).toContain('cache');
      expect(toolDef.annotations.destructiveHint).toBe(true);
      expect(toolDef.inputSchema.properties).toEqual({});
    });
  });

  describe('Tool Handler', () => {
    it('should return success message on cleared cache', async () => {
      // Index first
      await fixtures.indexer.indexAll(true);

      const request = createMockRequest('c_clear_cache', {});
      const result = await ClearCacheFeature.handleToolCall(request, fixtures.cacheClearer);

      expect(result.content[0].text).toContain('Cache cleared successfully');
      expect(result.content[0].text).toContain('Cache directory:');
    });

    it('should return error message when indexing is in progress', async () => {
      // Simulate indexing
      await clearTestCache(fixtures.config);
      fixtures.cache.setVectorStore([]);
      fixtures.cache.clearFileHashes();

      const indexPromise = fixtures.indexer.indexAll(true);
      expect(fixtures.indexer.isIndexing).toBe(true);

      const request = createMockRequest('c_clear_cache', {});
      const result = await ClearCacheFeature.handleToolCall(request, fixtures.cacheClearer);

      expect(result.content[0].text).toContain('Failed to clear cache');
      expect(result.content[0].text).toContain('indexing is in progress');

      await indexPromise;
    });

    it('should return error message when save is in progress', async () => {
      fixtures.cache.isSaving = true;

      const request = createMockRequest('c_clear_cache', {});
      const result = await ClearCacheFeature.handleToolCall(request, fixtures.cacheClearer);

      expect(result.content[0].text).toContain('Failed to clear cache');
      expect(result.content[0].text).toContain('being saved');

      fixtures.cache.isSaving = false;
    });

    it('should return error message when clear is already in progress', async () => {
      fixtures.cacheClearer.isClearing = true;

      const request = createMockRequest('c_clear_cache', {});
      const result = await ClearCacheFeature.handleToolCall(request, fixtures.cacheClearer);

      expect(result.content[0].text).toContain('Failed to clear cache');
      expect(result.content[0].text).toContain('already in progress');

      fixtures.cacheClearer.isClearing = false;
    });
  });
});

