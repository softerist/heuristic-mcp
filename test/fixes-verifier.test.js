import { describe, it, expect } from 'vitest';
import { loadConfig } from '../lib/config.js';
import { CodebaseIndexer } from '../features/index-codebase.js';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

async function withTempDir(testFn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heuristic-verify-'));
  try {
    await testFn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('verify fixes', () => {
  it('loads config defaults in workspace mode', async () => {
    await withTempDir(async (dir) => {
      const config = await loadConfig(dir);
      expect(config.searchDirectory).toBe(path.resolve(dir));
      expect(config.embeddingProcessPerBatch).toBe(false);
      expect(config.workerThreads).toBe('auto');
    });
  });

  it('does not use workers in test env', async () => {
    await withTempDir(async (dir) => {
      const indexer = new CodebaseIndexer({}, {}, {
        workerThreads: 2,
        embeddingProcessPerBatch: false,
        excludePatterns: [],
        searchDirectory: dir,
      });
      expect(indexer.shouldUseWorkers()).toBe(false);
    });
  });

  it('respects .gitignore rules in searchDirectory', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, '.gitignore'), 'secret_folder/\n*.secret', 'utf8');
      const indexer = new CodebaseIndexer({}, {}, {
        workerThreads: 0,
        embeddingProcessPerBatch: false,
        excludePatterns: [],
        searchDirectory: dir,
      });
      await indexer.loadGitignore();

      expect(indexer.isExcluded('secret_folder/file.txt')).toBe(true);
      expect(indexer.isExcluded('app.secret')).toBe(true);
      expect(indexer.isExcluded('app.js')).toBe(false);
    });
  });
});
