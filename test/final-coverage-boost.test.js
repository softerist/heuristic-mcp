
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmbeddingsCache } from '../lib/cache.js';
import * as callGraph from '../lib/call-graph.js';
import fs from 'fs/promises';
import { Worker } from 'worker_threads';
import EventEmitter from 'events';

// Mock worker_threads
vi.mock('worker_threads', () => {
  return {
    Worker: vi.fn(),
  };
});

// Mock fs/promises
vi.mock('fs/promises', () => {
  return {
    default: {
      stat: vi.fn().mockResolvedValue({ size: 100 }),
      readFile: vi.fn().mockResolvedValue('{}'),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
    },
  };
});

describe('Final Coverage Boost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('cache.js - Worker Edge Cases', () => {
    const config = {
      enableCache: true,
      cacheDirectory: '/cache',
      fileExtensions: ['js'],
      embeddingModel: 'test-model',
    };

    beforeEach(() => {
        // Default fs behavior
        fs.stat.mockResolvedValue({ size: 100 });
        fs.readFile.mockResolvedValue('{}');
    });

    it('should handle worker double-settling guard', { timeout: 1000 }, async () => {
      // Setup: only cache file triggers worker
      fs.stat.mockImplementation(async (path) => {
          if (path && path.includes('embeddings.json')) return { size: 6 * 1024 * 1024 };
          return { size: 100 };
      });

      // Provide valid meta to avoid early returns (though not strictly needed for this test)
      fs.readFile.mockImplementation(async (path) => {
          if (path.includes('meta.json')) return JSON.stringify({ version: 1, embeddingModel: 'test-model' });
          return '{}';
      });

      const mockWorker = new EventEmitter();
      mockWorker.postMessage = vi.fn();
      mockWorker.terminate = vi.fn();
      mockWorker.removeAllListeners = vi.fn(); 
      Worker.mockImplementation(function() { return mockWorker; });

      const cache = new EmbeddingsCache(config);
      
      // Wait for the worker to attach the 'message' listener
      const workerListenerReady = new Promise((resolve) => {
        mockWorker.on('newListener', (event) => {
          if (event === 'message') resolve();
        });
      });

      const loadPromise = cache.load();
      
      await workerListenerReady;

      // Trigger success message
      mockWorker.emit('message', { ok: true, data: [] });
      
      // Immediately trigger exit - acts as second "settle" attempt
      mockWorker.emit('exit', 0);
      
      await loadPromise;
      
      // If it didn't throw, we're good.
      expect(mockWorker.removeAllListeners).toHaveBeenCalled();
    });

    it('should handle worker error event', async () => {
      fs.stat.mockImplementation(async (path) => {
          if (path && path.includes('embeddings.json')) return { size: 6 * 1024 * 1024 };
          return { size: 100 };
      });
      fs.readFile.mockImplementation(async (path) => {
          if (path.includes('meta.json')) return JSON.stringify({ version: 1, embeddingModel: 'test-model' });
          return '{}';
      });

      const mockWorker = new EventEmitter();
      mockWorker.postMessage = vi.fn();
      mockWorker.terminate = vi.fn();
      mockWorker.removeAllListeners = vi.fn();
      Worker.mockImplementation(function() { return mockWorker; });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const cache = new EmbeddingsCache(config);
      
      const workerListenerReady = new Promise((resolve) => {
        mockWorker.on('newListener', (event) => {
          if (event === 'error') resolve();
        });
      });

      const loadPromise = cache.load();
      await workerListenerReady;

      const error = new Error('Worker exploded');
      mockWorker.emit('error', error);

      await loadPromise;
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Worker exploded'));
      consoleSpy.mockRestore();
    });

    it('should handle worker exit with non-zero code', async () => {
      fs.stat.mockImplementation(async (path) => {
          if (path && path.includes('embeddings.json')) return { size: 6 * 1024 * 1024 };
          return { size: 100 };
      });
      fs.readFile.mockImplementation(async (path) => {
          if (path.includes('meta.json')) return JSON.stringify({ version: 1, embeddingModel: 'test-model' });
          return '{}';
      });

      const mockWorker = new EventEmitter();
      mockWorker.postMessage = vi.fn();
      mockWorker.terminate = vi.fn();
      mockWorker.removeAllListeners = vi.fn();
      Worker.mockImplementation(function() { return mockWorker; });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const cache = new EmbeddingsCache(config);
      
      const workerListenerReady = new Promise((resolve) => {
        mockWorker.on('newListener', (event) => {
          if (event === 'exit') resolve();
        });
      });

      const loadPromise = cache.load();
      await workerListenerReady;

      mockWorker.emit('exit', 1);

      await loadPromise;
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('exited with code 1'));
      consoleSpy.mockRestore();
    });
  });

  describe('cache.js - Verbose Call Graph Loading', () => {
    it('should log when loading call graph in verbose mode', async () => {
        const config = {
            enableCache: true,
            cacheDirectory: '/cache',
            fileExtensions: ['js'],
            embeddingModel: 'test-model',
            verbose: true
        };
        
        fs.mkdir.mockResolvedValue(undefined);
        // readFile needs to return null for meta/cache/hash to skip main logic
        // but return valid JSON for call-graph
        fs.readFile.mockImplementation(async (path) => {
            if (path.endsWith('call-graph.json')) {
                return JSON.stringify({ 'file.js': { definitions: [], calls: [] } });
            }
            return null; // triggers "Missing cache metadata" early return, which is after call-graph load?
            // Wait, call-graph load is inside load().
        });
        
        // We need main cache load to succeed partially or reach the call-graph part.
        // Looking at cache.js:163, it reads meta, cache, hash.
        // If meta missing, it returns. We need meta to exist.
        
        fs.readFile.mockImplementation(async (filePath) => {
            if (filePath.endsWith('meta.json')) {
                return JSON.stringify({ version: 1, embeddingModel: 'test-model' });
            }
            if (filePath.endsWith('embeddings.json')) return '[]';
            if (filePath.endsWith('file-hashes.json')) return '{}';
            if (filePath.endsWith('call-graph.json')) {
                return JSON.stringify({ 'file.js': { definitions: [], calls: [] } });
            }
            return null;
        });

        // Mock fs.stat for readJsonFile to avoid worker
        fs.stat.mockResolvedValue({ size: 100 });

        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        
        const cache = new EmbeddingsCache(config);
        await cache.load();
        
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Cache] Loaded call-graph data'));
        consoleSpy.mockRestore();
    });
  });

  describe('call-graph.js - Coverage Gaps', () => {
      it('should ignore single-character definitions', () => {
          const content = `
            function a() {} 
            function b() {}
            class C {}
          `;
          const defs = callGraph.extractDefinitions(content, 'test.js');
          expect(defs).toHaveLength(0);
      });

      it('should handle merging multiple definitions and calls in buildCallGraph', () => {
          const fileCallData = new Map();
          fileCallData.set('file1.js', { definitions: ['CommonFunc'], calls: ['SharedTarget'] });
          fileCallData.set('file2.js', { definitions: ['CommonFunc'], calls: ['SharedTarget'] });
          // logic at lines 253, 262: checks if map.has(key)
          
          const graph = callGraph.buildCallGraph(fileCallData);
          
          expect(graph.defines.get('CommonFunc')).toHaveLength(2);
          expect(graph.defines.get('CommonFunc')).toContain('file1.js');
          expect(graph.defines.get('CommonFunc')).toContain('file2.js');

          expect(graph.calledBy.get('SharedTarget')).toHaveLength(2);
          expect(graph.calledBy.get('SharedTarget')).toContain('file1.js');
          expect(graph.calledBy.get('SharedTarget')).toContain('file2.js');
      });

      it('should ignore short symbols in extractSymbolsFromContent', () => {
          const content = `
            function a() {}
            class B {}
            let c = 1;
            function ValidName() {}
          `;
          const symbols = callGraph.extractSymbolsFromContent(content);
          expect(symbols).not.toContain('a');
          expect(symbols).not.toContain('B');
          expect(symbols).not.toContain('c');
          expect(symbols).toContain('ValidName');
      });
  });
});
