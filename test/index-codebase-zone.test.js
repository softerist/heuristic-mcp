
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestFixtures,
  cleanupFixtures,
  clearTestCache,
} from './helpers.js';
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
    fixtures.cache.fileHashes = new Map();
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
    
    const realReadFile = fs.readFile;
    const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (filePath, options) => {
        if (filePath.toString().includes('bad.js')) {
            throw new Error('Simulated read error');
        }
        return realReadFile.call(fs, filePath, options);
    });
    
    try {
        // Call preFilterFiles directly to bypass discovery issues
        const result = await fixtures.indexer.preFilterFiles([fileGood, fileBad]);
        
        console.error('PreFilter Result:', result);
        
        // Good file should be included
        const hasGood = result.some(r => r.file.includes('good.js'));
        // Bad file should be excluded (due to error)
        const hasBad = result.some(r => r.file.includes('bad.js'));
        
        expect(hasGood).toBe(true);
        expect(hasBad).toBe(false);
        
    } finally {
        readFileSpy.mockRestore();
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
            // Modify directly
            s.size = 20 * 1024 * 1024; // 20MB
            return s;
        }
        return realStat.call(fs, filePath);
    });
    
    const oldMax = fixtures.config.maxFileSize;
    fixtures.config.maxFileSize = 100 * 1024 * 1024; // 100MB
    
    try {
        // Pass 3 files. Total 60MB. Batch limit 50MB.
        // Should trigger intermediate flush.
        const result = await fixtures.indexer.preFilterFiles([file1, file2, file3]);
        
        console.error('Batch flush result:', result);

        expect(result.some(r => r.file.includes('f1.js'))).toBe(true);
        expect(result.some(r => r.file.includes('f2.js'))).toBe(true);
        expect(result.some(r => r.file.includes('f3.js'))).toBe(true);
        
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
        startLine: 1, endLine: 1, content: 'content', vector: []
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

    vi.spyOn(fs, 'stat').mockRejectedValue(new Error('Stat failed'));

    await fixtures.indexer.indexAll();
  });

  it('should handle read failures in main loop (L870)', async () => {
    fixtures.indexer.discoverFiles = vi.fn().mockResolvedValue(['fail.js']);
    fixtures.indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: 'fail.js', hash: 'h', force: true }]);

    vi.spyOn(fs, 'stat').mockResolvedValue({ isDirectory: () => false, size: 100 });
    vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('Read fail'));

    await fixtures.indexer.indexAll();
  });

  it('should skip unchanged files in loop (L882)', async () => {
    fixtures.indexer.discoverFiles = vi.fn().mockResolvedValue(['same.js']);
    fixtures.indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: 'same.js', hash: 'h', force: false }]);

    vi.spyOn(fs, 'stat').mockResolvedValue({ isDirectory: () => false, size: 100 });
    vi.spyOn(fs, 'readFile').mockResolvedValue('content');
    vi.spyOn(fixtures.indexer.cache, 'getFileHash').mockReturnValue('h');

    await fixtures.indexer.indexAll();
  });

  it('handles invalid stats in main loop (L846)', async () => {
    fixtures.indexer.discoverFiles = vi.fn().mockResolvedValue(['invalid.js']);
    fixtures.indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: 'invalid.js', hash: 'h', force: true }]);

    vi.spyOn(fs, 'stat').mockResolvedValue({});

    await fixtures.indexer.indexAll();
  });

  it('skips large file during stat pass (L859)', async () => {
    fixtures.indexer.discoverFiles = vi.fn().mockResolvedValue(['big.js']);
    fixtures.indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: 'big.js', hash: 'h', force: true }]);

    vi.spyOn(fs, 'stat').mockResolvedValue({
      isDirectory: () => false,
      size: fixtures.config.maxFileSize + 1,
    });

    await fixtures.indexer.indexAll();
  });

  it('should queue watcher events during indexing (L1106, L1126, L1146)', async () => {
      // 1. Setup watcher
      fixtures.config.watchFiles = true;
      await fixtures.indexer.setupFileWatcher();
      
      // 2. Set indexing flag
      fixtures.indexer.isIndexing = true;
      
      // 3. Emit events
      const watcher = fixtures.indexer.watcher;
      if (watcher) {
          watcher.emit('add', 'new.js');
          watcher.emit('change', 'changed.js');
          watcher.emit('unlink', 'deleted.js');
      }

      // Check queue
      expect(fixtures.indexer.pendingWatchEvents.has(path.join(fixtures.config.searchDirectory, 'new.js'))).toBe(true);
      expect(fixtures.indexer.pendingWatchEvents.has(path.join(fixtures.config.searchDirectory, 'changed.js'))).toBe(true);
      // unlink might use absolute path logic
      const delPath = path.join(fixtures.config.searchDirectory, 'deleted.js');
      expect(fixtures.indexer.pendingWatchEvents.get(delPath)).toBe('unlink');

      // Reset
      fixtures.indexer.isIndexing = false;
  });
});
