
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  createTestFixtures,
  cleanupFixtures,
  clearTestCache,
} from './helpers.js';
import fs from 'fs/promises';
import path from 'path';

describe('CodebaseIndexer Edge Cases', () => {
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

  it('should handle race conditions where file status changes during indexing', async () => {
    // Setup a directory with specific files
    const subDir = path.join(fixtures.config.searchDirectory, 'edge_cases');
    await fs.mkdir(subDir, { recursive: true });

    const fileInvalidStat = path.join(subDir, 'invalid_stat.js');
    const fileIsDir = path.join(subDir, 'is_dir.js'); // Will become directory
    const fileTooLarge = path.join(subDir, 'too_large.js');
    const fileReadError = path.join(subDir, 'read_error.js');
    const fileUnchanged = path.join(subDir, 'unchanged.js');

    await fs.writeFile(fileInvalidStat, 'content');
    await fs.writeFile(fileIsDir, 'content');
    await fs.writeFile(fileTooLarge, 'content');
    await fs.writeFile(fileReadError, 'content');
    await fs.writeFile(fileUnchanged, 'content');

    // Pre-calculate hash for unchanged file
    const { hashContent } = await import('../lib/utils.js');
    const hash = hashContent('content');
    
    // We want to verify these specific paths in indexAll loop (lines 805-844)
    // To do that, we need to mock fs calls.
    // Since we are using real fs in other parts (like discovery), we should only mock for these specific files
    // or use a smart mock that falls back to real fs.

    const realStat = fs.stat;
    const realReadFile = fs.readFile;

    let statCallCount = 0;

    // Spy on fs.stat
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (filePath) => {
      // Allow helper calls and basic setup to pass through
      if (!filePath.includes('edge_cases')) {
        return realStat.call(fs, filePath);
      }

      // During preFilterFiles (first pass), everything looks normal
      // We can detect "second pass" (inside loop) roughly by context or count, 
      // but simpler is to check if we are already mocked "bad" state.
      // However, preFilter calls stat, then readFile.
      // Loop calls stat, then readFile.
      
      // Let's rely on the fact that preFilter runs first.
      // But preFilter runs in parallel. 
      // We can check the stack trace or just count calls? No, count is flaky.
      
      // Better strategy: mocking these files specifically to be "normal" first, then "weird".
      // But simpler: preFilter checks size. Loop checks size again.
      
      // invalid_stat.js: 
      // preFilter: returns normal stat.
      // Loop: returns null or non-function isDirectory? (Line 804 check: !stats || typeof stats.isDirectory ...)
      
      // We can use a Map to track how many times a file has been stat-ed.
      // 1st time (preFilter): good.
      // 2nd time (loop): bad.
      
      const p = path.normalize(filePath);
      
      // invalid_stat.js
      if (p.includes('invalid_stat.js')) {
        // Return a valid stat object that has a "bad" isDirectory property on 2nd call?
        // Actually line 804 checks: if (!stats || typeof stats.isDirectory !== 'function')
        // So we can return { isDirectory: 'not a function' } or null? 
        // But preFilter needs it to be valid.
        // preFilter checks: stats.isDirectory() (line 518).
        
        // So we need stateful mock.
      }

      return realStat.call(fs, filePath);
    });

    // We can't easily state-track inside the mock without variables from closure.
    // Let's use a counter map.
    const callCounts = new Map();
    const getCount = (f) => {
        const c = callCounts.get(f) || 0;
        callCounts.set(f, c + 1);
        return c;
    }

    statSpy.mockImplementation(async (filePath) => {
        if (!filePath.toString().includes('edge_cases')) return realStat.call(fs, filePath);
        
        const f = path.normalize(filePath.toString());
        const count = getCount(f);

        // Files need to pass preFilter (count 0)
        // Then fail in loop (count 1)
        
        if (f.includes('invalid_stat.js')) {
            if (count === 0) return realStat.call(fs, filePath); // preFilter pass
            return { isDirectory: 'not-a-function', size: 100 }; // Loop fail (line 804)
        }

        if (f.includes('is_dir.js')) {
             if (count === 0) return realStat.call(fs, filePath); // preFilter pass
             return { isDirectory: () => true, size: 100 }; // Loop fail (line 813)
        }

        if (f.includes('too_large.js')) {
             if (count === 0) return realStat.call(fs, filePath); // preFilter pass
             return { isDirectory: () => false, size: 1024 * 1024 * 100 }; // Loop fail (line 817) - 100MB
        }
        
        // read_error.js passes stat both times
        // unchanged.js passes stat both times

        return realStat.call(fs, filePath);
    });

    // Mock readFile
    const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (filePath, options) => {
        if (!filePath.toString().includes('edge_cases')) return realReadFile.call(fs, filePath, options);

        const f = path.normalize(filePath.toString());
        // preFilter calls readFile too!
        // We need read_error.js to pass preFilter readFile, but fail loop readFile.
        
        // Note: preFilter calls readFile (line 543)
        // Loop calls readFile (line 827)

        // Reset counts? No, distinct from stat.
        // But we can use the same map key suffix or just assume strict ordering.
        // Let's assume preFilter reads it first.
        
        if (f.includes('read_error.js')) {
            // Check if this is likely the second read (loop)
            // We can just set a flag on the file object? No.
            // Let's use a separate counter for reads.
            // Actually, we can reuse the callCounts map logic or distinct one.
        }
        
        return realReadFile.call(fs, filePath, options);
    });
    
    const readCounts = new Map();
    readFileSpy.mockImplementation(async (filePath, options) => {
       if (!filePath.toString().includes('edge_cases')) return realReadFile.call(fs, filePath, options);
       
       const f = path.normalize(filePath.toString());
       const count = (readCounts.get(f) || 0);
       readCounts.set(f, count + 1);

       if (f.includes('read_error.js')) {
           if (count === 0) return realReadFile.call(fs, filePath, options); // preFilter pass
           throw new Error('Simulated read failure'); // Loop fail (line 828)
       }

        if (f.includes('unchanged.js')) {
            // Loop pass read, but then we want to simulate "liveHash === cache" (line 840)
            // The file content is 'content'. Hash is known.
            // The test simply needs to ensure the cache HAS this hash before loop check?
            // But indexAll clears cache if force=true?
            // If force=false, preFilter skips it.
            // So we must run with force=true (to bypass preFilter skip), 
            // BUT force=true sets "force" flag in batch item (line 707).
            // Inside loop: if (!force && liveHash && ...)
            // So if force is true, Line 840 is skipped!
            
            // Wait. Line 840: if (!force && liveHash && ...)
            // If we run indexAll(true), force is true. Line 840 is skipped.
            // If we run indexAll(false), preFilter skips unchanged files.
            
            // How to hit Line 840 then?
            // "liveHash" comes from re-reading the file.
            // "presetHash" comes from preFilter.
            
            // If preFilter says "changed" (hash mismatch), it returns { file, hash, force: false }.
            // Then in loop, if we re-read file and hash NOW matches cache...
            // That means cache was updated between preFilter and loop?
            // OR preFilter thought it was changed, but loop found it matches cache?
            
            // Example scenario:
            // 1. preFilter sees file is changed (vs cache).
            // 2. Loop runs.
            // 3. Someone updates cache to match file (race condition?).
            // 4. Line 840 check sees match and skips.
            
            // To simulate this:
            // - preFilter must see mismatch (e.g. cache has 'old', file has 'new').
            // - Loop runs.
            // - Before line 840, we sneakily update cache to have 'new'.
            // - OR we mock readFile in loop to return content that matches 'old' (if cache has 'old')?
            
            // Let's try:
            // Cache has 'content'.
            // preFilter Mock: returns { file, hash: 'diff', force: false } ? 
            // No, preFilter reads real file.
            
            // Setup:
            // Real file has 'content'.
            // Cache has 'old'.
            // preFilter reads 'content'. 'content' != 'old'. Passes.
            // Loop starts.
            // Loop reads 'content'. Hash is 'H(content)'.
            // We want (cache.getFileHash(file) === 'H(content)').
            // But cache has 'old'.
            // So we need to update cache to 'H(content)' AFTER preFilter but BEFORE loop check.
            
            // We can do this in the `fs.stat` mock for `unchanged.js` (which runs in loop before read).
            if (f.includes('unchanged.js') && count > 0) { // inside loop stat
                fixtures.cache.setFileHash(f, hash);
            }
        }

       return realReadFile.call(fs, filePath, options);
    });

    // Set initial cache for unchanged.js to satisfy pre-reqs
    fixtures.cache.setFileHash(fileUnchanged, 'old_value_to_cause_mismatch_initially');

    try {
        await fixtures.indexer.indexAll(false); // force=false to enable line 840 check
    } finally {
        statSpy.mockRestore();
        readFileSpy.mockRestore();
        await fs.rm(subDir, { recursive: true, force: true });
    }
  });
});
