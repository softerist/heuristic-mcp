import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestFixtures, cleanupFixtures, clearTestCache } from './helpers.js';
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
    
    const subDir = path.join(fixtures.config.searchDirectory, 'edge_cases');
    await fs.mkdir(subDir, { recursive: true });

    const fileInvalidStat = path.join(subDir, 'invalid_stat.js');
    const fileIsDir = path.join(subDir, 'is_dir.js'); 
    const fileTooLarge = path.join(subDir, 'too_large.js');
    const fileReadError = path.join(subDir, 'read_error.js');
    const fileUnchanged = path.join(subDir, 'unchanged.js');

    await fs.writeFile(fileInvalidStat, 'content');
    await fs.writeFile(fileIsDir, 'content');
    await fs.writeFile(fileTooLarge, 'content');
    await fs.writeFile(fileReadError, 'content');
    await fs.writeFile(fileUnchanged, 'content');

    
    const { hashContent } = await import('../lib/utils.js');
    const hash = hashContent('content');

    
    
    
    

    const realStat = fs.stat;
    const realReadFile = fs.readFile;

    let statCallCount = 0;

    
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (filePath) => {
      
      if (!filePath.includes('edge_cases')) {
        return realStat.call(fs, filePath);
      }

      
      
      
      
      

      
      
      

      
      

      
      
      

      
      
      

      const p = path.normalize(filePath);

      
      if (p.includes('invalid_stat.js')) {
        
        
        
        
        
        
      }

      return realStat.call(fs, filePath);
    });

    
    
    const callCounts = new Map();
    const getCount = (f) => {
      const c = callCounts.get(f) || 0;
      callCounts.set(f, c + 1);
      return c;
    };

    statSpy.mockImplementation(async (filePath) => {
      if (!filePath.toString().includes('edge_cases')) return realStat.call(fs, filePath);

      const f = path.normalize(filePath.toString());
      const count = getCount(f);

      
      

      if (f.includes('invalid_stat.js')) {
        if (count === 0) return realStat.call(fs, filePath); 
        return { isDirectory: 'not-a-function', size: 100 }; 
      }

      if (f.includes('is_dir.js')) {
        if (count === 0) return realStat.call(fs, filePath); 
        return { isDirectory: () => true, size: 100 }; 
      }

      if (f.includes('too_large.js')) {
        if (count === 0) return realStat.call(fs, filePath); 
        return { isDirectory: () => false, size: 1024 * 1024 * 100 }; 
      }

      
      

      return realStat.call(fs, filePath);
    });

    
    const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (filePath, options) => {
      if (!filePath.toString().includes('edge_cases'))
        return realReadFile.call(fs, filePath, options);

      const f = path.normalize(filePath.toString());
      
      

      
      

      
      
      

      if (f.includes('read_error.js')) {
        
        
        
        
      }

      return realReadFile.call(fs, filePath, options);
    });

    const readCounts = new Map();
    readFileSpy.mockImplementation(async (filePath, options) => {
      if (!filePath.toString().includes('edge_cases'))
        return realReadFile.call(fs, filePath, options);

      const f = path.normalize(filePath.toString());
      const count = readCounts.get(f) || 0;
      readCounts.set(f, count + 1);

      if (f.includes('read_error.js')) {
        if (count === 0) return realReadFile.call(fs, filePath, options); 
        throw new Error('Simulated read failure'); 
      }

      if (f.includes('unchanged.js')) {
        
        
        
        
        
        
        
        
        

        
        
        

        
        
        

        
        
        
        

        
        
        
        
        

        
        
        
        
        

        
        
        
        

        
        
        
        
        
        
        
        
        

        
        if (f.includes('unchanged.js') && count > 0) {
          
          fixtures.cache.setFileHash(f, hash);
        }
      }

      return realReadFile.call(fs, filePath, options);
    });

    
    fixtures.cache.setFileHash(fileUnchanged, 'old_value_to_cause_mismatch_initially');

    try {
      await fixtures.indexer.indexAll(false); 
    } finally {
      statSpy.mockRestore();
      readFileSpy.mockRestore();
      await fs.rm(subDir, { recursive: true, force: true });
    }
  });
});
