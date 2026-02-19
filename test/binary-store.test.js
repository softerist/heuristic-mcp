import { describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  BinaryVectorStore,
  cleanupStaleBinaryArtifacts,
  readBinaryStoreTelemetry,
} from '../lib/vector-store-binary.js';

async function withTempDir(testFn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heuristic-binary-'));
  try {
    await testFn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('BinaryVectorStore smoke', () => {
  it('writes and loads a larger store', async () => {
    await withTempDir(async (dir) => {
      const count = 512;
      const chunks = new Array(count).fill(null).map((_, i) => ({
        file: path.join(dir, `file-${i % 8}.js`),
        startLine: i + 1,
        endLine: i + 2,
        content: `line-${i}`,
        vector: new Float32Array([i / 100, i / 200, i / 300]),
      }));

      const store = await BinaryVectorStore.write(dir, chunks, { contentCacheEntries: 4 });
      expect(store.length).toBe(count);

      const loaded = await BinaryVectorStore.load(dir, { contentCacheEntries: 4 });
      expect(loaded.length).toBe(count);
      expect(loaded.dim).toBe(3);
      expect(await loaded.getContent(0)).toContain('line-0');

      await store.close();
      await loaded.close();
    });
  });

  it('supports disk-backed vector reads', async () => {
    await withTempDir(async (dir) => {
      const chunks = [
        {
          file: path.join(dir, 'file-a.js'),
          startLine: 1,
          endLine: 2,
          content: 'const x = 1;',
          vector: new Float32Array([0.1, 0.2, 0.3]),
        },
      ];

      const store = await BinaryVectorStore.write(dir, chunks, { contentCacheEntries: 2 });
      await store.close();

      const loaded = await BinaryVectorStore.load(dir, {
        contentCacheEntries: 2,
        vectorCacheEntries: 1,
        vectorLoadMode: 'disk',
      });

      const vector = loaded.getVector(0);
      expect(vector).toBeInstanceOf(Float32Array);
      expect(vector.length).toBe(3);

      await loaded.close();
    });
  });

  it('rolls back atomically when target rename fails', async () => {
    await withTempDir(async (dir) => {
      const originalChunks = [
        {
          file: path.join(dir, 'orig-a.js'),
          startLine: 1,
          endLine: 2,
          content: 'original-a',
          vector: new Float32Array([0.1, 0.2, 0.3]),
        },
        {
          file: path.join(dir, 'orig-b.js'),
          startLine: 3,
          endLine: 4,
          content: 'original-b',
          vector: new Float32Array([0.4, 0.5, 0.6]),
        },
      ];

      const initialStore = await BinaryVectorStore.write(dir, originalChunks);
      await initialStore.close();

      const replacementChunks = new Array(5).fill(null).map((_, i) => ({
        file: path.join(dir, `new-${i}.js`),
        startLine: i + 1,
        endLine: i + 2,
        content: `new-${i}`,
        vector: new Float32Array([i + 0.1, i + 0.2, i + 0.3]),
      }));

      const originalRename = fs.rename.bind(fs);
      let injected = false;
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
        const from = String(source);
        const to = String(target);
        const isTempToLiveVectors =
          from.includes('.tmp-') && to.endsWith(`${path.sep}vectors.bin`);
        if (!injected && isTempToLiveVectors) {
          injected = true;
          const err = new Error('simulated non-retryable failure');
          err.code = 'EXDEV';
          throw err;
        }
        return originalRename(source, target);
      });

      await expect(
        BinaryVectorStore.write(dir, replacementChunks, {
          renameOptions: { retries: 0, delayMs: 1, maxDelayMs: 1 },
        })
      ).rejects.toThrow(/simulated non-retryable failure/i);

      renameSpy.mockRestore();

      const telemetry = await readBinaryStoreTelemetry(dir);
      expect(telemetry?.totals?.atomicReplaceFailures).toBeGreaterThan(0);
      expect(telemetry?.totals?.rollbackCount).toBeGreaterThan(0);

      const recovered = await BinaryVectorStore.load(dir);
      expect(recovered.length).toBe(originalChunks.length);
      expect(await recovered.getContent(0)).toContain('original-a');
      expect(await recovered.getContent(1)).toContain('original-b');
      await recovered.close();
    });
  });

  it('falls back to copy when rename remains locked', async () => {
    await withTempDir(async (dir) => {
      const chunks = [
        {
          file: path.join(dir, 'copy-fallback.js'),
          startLine: 1,
          endLine: 2,
          content: 'copy fallback content',
          vector: new Float32Array([0.11, 0.22, 0.33]),
        },
      ];

      const originalRename = fs.rename.bind(fs);
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
        const from = String(source);
        const to = String(target);
        const isTempToLiveTarget = from.includes('.tmp-') && !to.includes('.bak-');
        if (isTempToLiveTarget) {
          const err = new Error('simulated persistent rename lock');
          err.code = 'EPERM';
          throw err;
        }
        return originalRename(source, target);
      });
      const copySpy = vi.spyOn(fs, 'copyFile');

      const store = await BinaryVectorStore.write(dir, chunks, {
        renameOptions: { retries: 0, delayMs: 1, maxDelayMs: 1 },
      });
      expect(store.length).toBe(1);
      expect(copySpy).toHaveBeenCalled();
      await store.close();

      const telemetry = await readBinaryStoreTelemetry(dir);
      expect(telemetry?.totals?.fallbackCopyCount).toBeGreaterThan(0);

      renameSpy.mockRestore();
      copySpy.mockRestore();

      const loaded = await BinaryVectorStore.load(dir);
      expect(loaded.length).toBe(1);
      expect(await loaded.getContent(0)).toContain('copy fallback content');
      await loaded.close();
    });
  });

  it('cleans stale binary temp artifacts on startup', async () => {
    await withTempDir(async (dir) => {
      const staleTmp = path.join(dir, 'vectors.bin.tmp-999999');
      await fs.writeFile(staleTmp, 'stale');
      const oldDate = new Date(Date.now() - 10 * 60 * 1000);
      await fs.utimes(staleTmp, oldDate, oldDate);

      const result = await cleanupStaleBinaryArtifacts(dir, { minAgeMs: 1000 });
      expect(result.removed).toBe(1);
      expect(result.scanned).toBeGreaterThanOrEqual(1);

      await expect(fs.access(staleTmp)).rejects.toThrow();

      const telemetry = await readBinaryStoreTelemetry(dir);
      expect(telemetry?.totals?.startupCleanupRuns).toBeGreaterThan(0);
      expect(telemetry?.totals?.staleTempFilesRemoved).toBeGreaterThan(0);
    });
  });

  it('skips temp cleanup for active process artifacts', async () => {
    await withTempDir(async (dir) => {
      const activeTmp = path.join(dir, `vectors.bin.tmp-${process.pid}`);
      await fs.writeFile(activeTmp, 'active');
      const oldDate = new Date(Date.now() - 10 * 60 * 1000);
      await fs.utimes(activeTmp, oldDate, oldDate);

      const result = await cleanupStaleBinaryArtifacts(dir, { minAgeMs: 1000 });
      expect(result.removed).toBe(0);
      expect(result.skippedActive).toBeGreaterThanOrEqual(1);

      await expect(fs.access(activeTmp)).resolves.toBeUndefined();
    });
  });
});
