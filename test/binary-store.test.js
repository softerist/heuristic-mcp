import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { BinaryVectorStore } from '../lib/vector-store-binary.js';

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
});
