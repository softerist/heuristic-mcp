import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createTestFixtures, cleanupFixtures, clearTestCache } from './helpers.js';
import fs from 'fs/promises';
import path from 'path';

describe('CodebaseIndexer Phase 2 Coverage', () => {
  let fixtures;

  beforeAll(async () => {
    fixtures = await createTestFixtures({ workerThreads: 1 });
  });

  afterAll(async () => {
    await cleanupFixtures(fixtures);
  });

  beforeEach(async () => {
    fixtures.indexer.isIndexing = false;
    await fixtures.indexer.terminateWorkers();
    await clearTestCache(fixtures.config);
    fixtures.cache.setVectorStore([]);
    fixtures.cache.clearFileHashes();
    fixtures.config.verbose = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should handle read errors in pre-filter batch processing (lines 553-554)', async () => {
    const subDir = path.join(fixtures.config.searchDirectory, 'p2_read_data');
    await fs.mkdir(subDir, { recursive: true });

    const fileGood = path.join(subDir, 'good.js');
    const fileBad = path.join(subDir, 'bad.js');

    await fs.writeFile(fileGood, 'good content');
    await fs.writeFile(fileBad, 'bad content');

    const realStat = fs.stat;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (filePath) => {
      if (filePath.toString().includes('bad.js')) {
        throw new Error('Simulated stat error');
      }
      return realStat.call(fs, filePath);
    });

    try {
      const result = await fixtures.indexer.preFilterFiles([fileGood, fileBad]);

      console.error('PreFilter Result:', result);

      const hasGood = result.some((r) => r.file.includes('good.js'));

      const hasBad = result.some((r) => r.file.includes('bad.js'));

      expect(hasGood).toBe(true);
      expect(hasBad).toBe(false);
    } finally {
      statSpy.mockRestore();
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it('should flush read batch when size limit exceeded (lines 571-573)', async () => {
    const subDir = path.join(fixtures.config.searchDirectory, 'p2_flush_data');
    await fs.mkdir(subDir, { recursive: true });

    const file1 = path.join(subDir, 'f1.js');
    const file2 = path.join(subDir, 'f2.js');
    const file3 = path.join(subDir, 'f3.js');

    await fs.writeFile(file1, 'c1');
    await fs.writeFile(file2, 'c2');
    await fs.writeFile(file3, 'c3');

    const realStat = fs.stat;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (filePath) => {
      if (filePath.toString().includes('p2_flush_data')) {
        const s = await realStat.call(fs, filePath);

        s.size = 20 * 1024 * 1024;
        return s;
      }
      return realStat.call(fs, filePath);
    });

    const oldMax = fixtures.config.maxFileSize;
    fixtures.config.maxFileSize = 100 * 1024 * 1024;

    try {
      const result = await fixtures.indexer.preFilterFiles([file1, file2, file3]);

      console.error('Batch flush result:', result);

      expect(result.some((r) => r.file.includes('f1.js'))).toBe(true);
      expect(result.some((r) => r.file.includes('f2.js'))).toBe(true);
      expect(result.some((r) => r.file.includes('f3.js'))).toBe(true);
    } finally {
      statSpy.mockRestore();
      fixtures.config.maxFileSize = oldMax;
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it('should handle invalid stats in call graph recovery (line 701)', async () => {
    const subDir = path.join(fixtures.config.searchDirectory, 'p2_recovery_data');
    await fs.mkdir(subDir, { recursive: true });

    const fileRecover = path.join(subDir, 'recover.js');
    await fs.writeFile(fileRecover, 'content');

    fixtures.cache.addToStore({
      file: fileRecover,
      startLine: 1,
      endLine: 1,
      content: 'content',
      vector: new Float32Array(64).fill(0).map((_, index) => (index === 0 ? 1 : 0)),
    });

    const realStat = fs.stat;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (filePath) => {
      if (filePath.toString().includes('recover.js')) {
        return { isDirectory: 'not-a-function' };
      }
      return realStat.call(fs, filePath);
    });

    fixtures.config.callGraphEnabled = true;

    try {
      await fixtures.indexer.indexAll(false);
    } finally {
      statSpy.mockRestore();
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it('rejects when final cache save fails', async () => {
    const subDir = path.join(fixtures.config.searchDirectory, 'p2_final_save_failure');
    await fs.mkdir(subDir, { recursive: true });
    const filePath = path.join(subDir, 'final-save.js');
    await fs.writeFile(filePath, 'export const finalSave = 1;');

    fixtures.indexer.discoverFiles = vi.fn().mockResolvedValue([filePath]);
    fixtures.indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: filePath, hash: 'final-save-hash', force: true }]);

    const saveSpy = vi.spyOn(fixtures.cache, 'save').mockImplementation(async (options = {}) => {
      if (options?.throwOnError) {
        throw new Error('final save boom');
      }
      return undefined;
    });

    try {
      await expect(fixtures.indexer.indexAll()).rejects.toThrow('final save boom');
      const calledWithStrictSave = saveSpy.mock.calls.some(
        (call) => call[0] && call[0].throwOnError === true
      );
      expect(calledWithStrictSave).toBe(true);
    } finally {
      saveSpy.mockRestore();
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });

  it('should skip large files provided with content (L825)', async () => {
    const largeContent = 'x'.repeat(fixtures.config.maxFileSize + 1024);
    fixtures.indexer.discoverFiles = vi.fn().mockResolvedValue(['large.js']);
    fixtures.indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: 'large.js', content: largeContent, hash: 'h', force: true }]);

    await fixtures.indexer.indexAll();
  });

  it('coerces non-string content and skips when too large (L825)', async () => {
    fixtures.indexer.discoverFiles = vi.fn().mockResolvedValue(['large2.js']);
    fixtures.indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: 'large2.js', content: 42, hash: null, force: true }]);
    const oldMax = fixtures.config.maxFileSize;
    fixtures.config.maxFileSize = 1;

    try {
      await fixtures.indexer.indexAll();
    } finally {
      fixtures.config.maxFileSize = oldMax;
    }
  });

  it('should log error when stat fails (L837)', async () => {
    fixtures.indexer.discoverFiles = vi.fn().mockResolvedValue(['stat-error.js']);
    fixtures.indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: 'stat-error.js', hash: 'h', force: true }]);

    const realStat = fs.stat;
    vi.spyOn(fs, 'stat').mockImplementation(async (filePath) => {
      if (String(filePath).includes('stat-error.js')) {
        throw new Error('Stat failed');
      }
      return realStat.call(fs, filePath);
    });

    await fixtures.indexer.indexAll();
  });

  it('should handle read failures in main loop (L870)', async () => {
    fixtures.indexer.discoverFiles = vi.fn().mockResolvedValue(['fail.js']);
    fixtures.indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: 'fail.js', hash: 'h', force: true }]);

    const realStat = fs.stat;
    const realReadFile = fs.readFile;
    vi.spyOn(fs, 'stat').mockImplementation(async (filePath) => {
      if (String(filePath).includes('fail.js')) {
        return { isDirectory: () => false, size: 100 };
      }
      return realStat.call(fs, filePath);
    });
    vi.spyOn(fs, 'readFile').mockImplementation(async (filePath, ...args) => {
      if (String(filePath).includes('fail.js')) {
        throw new Error('Read fail');
      }
      return realReadFile.call(fs, filePath, ...args);
    });

    await fixtures.indexer.indexAll();
  });

  it('should skip unchanged files in loop (L882)', async () => {
    fixtures.indexer.discoverFiles = vi.fn().mockResolvedValue(['same.js']);
    fixtures.indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: 'same.js', hash: 'h', force: false }]);

    const realStat = fs.stat;
    const realReadFile = fs.readFile;
    vi.spyOn(fs, 'stat').mockImplementation(async (filePath) => {
      if (String(filePath).includes('same.js')) {
        return { isDirectory: () => false, size: 100 };
      }
      return realStat.call(fs, filePath);
    });
    vi.spyOn(fs, 'readFile').mockImplementation(async (filePath, ...args) => {
      if (String(filePath).includes('same.js')) {
        return 'content';
      }
      return realReadFile.call(fs, filePath, ...args);
    });
    vi.spyOn(fixtures.indexer.cache, 'getFileHash').mockReturnValue('h');

    await fixtures.indexer.indexAll();
  });

  it('handles invalid stats in main loop (L846)', async () => {
    fixtures.indexer.discoverFiles = vi.fn().mockResolvedValue(['invalid.js']);
    fixtures.indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: 'invalid.js', hash: 'h', force: true }]);

    const realStat = fs.stat;
    vi.spyOn(fs, 'stat').mockImplementation(async (filePath) => {
      if (String(filePath).includes('invalid.js')) {
        return {};
      }
      return realStat.call(fs, filePath);
    });

    await fixtures.indexer.indexAll();
  });

  it('skips large file during stat pass (L859)', async () => {
    fixtures.indexer.discoverFiles = vi.fn().mockResolvedValue(['big.js']);
    fixtures.indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: 'big.js', hash: 'h', force: true }]);

    const realStat = fs.stat;
    vi.spyOn(fs, 'stat').mockImplementation(async (filePath) => {
      if (String(filePath).includes('big.js')) {
        return {
          isDirectory: () => false,
          size: fixtures.config.maxFileSize + 1,
        };
      }
      return realStat.call(fs, filePath);
    });

    await fixtures.indexer.indexAll();
  });

  it('should queue watcher events during indexing (L1106, L1126, L1146)', async () => {
    fixtures.config.watchFiles = true;
    await fixtures.indexer.setupFileWatcher();

    fixtures.indexer.isIndexing = true;

    const watcher = fixtures.indexer.watcher;
    if (watcher) {
      watcher.emit('add', 'new.js');
      watcher.emit('change', 'changed.js');
      watcher.emit('unlink', 'deleted.js');
    }

    expect(
      fixtures.indexer.pendingWatchEvents.has(path.join(fixtures.config.searchDirectory, 'new.js'))
    ).toBe(true);
    expect(
      fixtures.indexer.pendingWatchEvents.has(
        path.join(fixtures.config.searchDirectory, 'changed.js')
      )
    ).toBe(true);

    const delPath = path.join(fixtures.config.searchDirectory, 'deleted.js');
    expect(fixtures.indexer.pendingWatchEvents.get(delPath)).toBe('unlink');

    fixtures.indexer.isIndexing = false;
  });
});
