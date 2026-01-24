/**
 * Additional coverage for test helpers
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn(async () => async () => ({
    data: new Float32Array([1, 0, 0]),
  })),
}));

import fs from 'fs/promises';
import { pipeline } from '@xenova/transformers';
import { createTestFixtures, getEmbedder, clearTestCache, waitFor } from './helpers.js';

describe('Test helpers', () => {
  it('caches embedder instance across calls', async () => {
    const config = { embeddingModel: 'test-model' };
    const first = await getEmbedder(config);
    const second = await getEmbedder(config);

    expect(first).toBe(second);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it('creates fixtures with mock embedder and normalization', async () => {
    const fixtures = await createTestFixtures({ useRealEmbedder: false });
    const output = await fixtures.embedder('', { normalize: true });

    expect(output.data.length).toBeGreaterThan(0);
    expect(fixtures.cache).toBeDefined();
    expect(fixtures.indexer).toBeDefined();
  });

  it('handles clearTestCache errors gracefully', async () => {
    const rmSpy = vi.spyOn(fs, 'rm').mockRejectedValue(new Error('boom'));
    await expect(clearTestCache({ cacheDirectory: 'missing' })).resolves.toBeUndefined();
    rmSpy.mockRestore();
  });

  it('waitFor returns false when condition is never met', async () => {
    const result = await waitFor(async () => false, 50, 10);
    expect(result).toBe(false);
  });
});
