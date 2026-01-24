import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';

// Master mock for everything
vi.mock('fs/promises');
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      close: vi.fn().mockResolvedValue(true),
    })),
  },
}));

// Safe Mock Worker
class SafeMockWorker extends EventEmitter {
  constructor() {
    super();
    this.postMessage = vi.fn();
    this.terminate = vi.fn().mockResolvedValue(0);
    this.threadId = Math.random();
  }
  off = this.removeListener;
}

describe('Master Coverage Maximizer', () => {
  describe('lib/cache.js', () => {
    let EmbeddingsCache;
    beforeEach(async () => {
      vi.resetModules();
      const mod = await import('../lib/cache.js');
      EmbeddingsCache = mod.EmbeddingsCache;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('targets initHnswIndex retry logic via buildAnnIndex', async () => {
      const mockIndex = {
        initIndex: vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error('1');
          })
          .mockImplementationOnce(() => {
            throw new Error('2');
          })
          .mockReturnValue(true),
        addPoint: vi.fn(),
        setEf: vi.fn(),
      };
      const cache = new EmbeddingsCache({ annMetric: 'l2' });
      cache.vectorStore = [{ vector: [0.1] }];
      const Factory = vi.fn(function () {
        return mockIndex;
      });

      await cache.buildAnnIndex(Factory, 1);
      expect(mockIndex.initIndex).toHaveBeenCalledTimes(3);
    });

    it('targets clearCallGraphData failure (line 520)', async () => {
      const cache = new EmbeddingsCache({
        enableCache: true,
        cacheDirectory: '/x',
        verbose: true,
      });
      vi.mocked(fs.rm).mockRejectedValue(new Error('fail'));
      await cache.clearCallGraphData({ removeFile: true });
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to remove call-graph cache')
      );
    });

    it('targets getRelatedFiles missing graph logic (line 602)', async () => {
      const cache = new EmbeddingsCache({ callGraphEnabled: true });
      cache.fileCallData.set('a.js', { definitions: [], calls: [] });
      cache.callGraph = null;
      // Force dynamic import to fail or not set callGraph
      const result = await cache.getRelatedFiles(['test']);
      expect(result.size).toBe(0);
    });
  });

  describe('features/index-codebase.js', () => {
    let CodebaseIndexer, handleToolCall;

    beforeEach(async () => {
      vi.resetModules();
      // Mock os
      vi.doMock('os', () => ({
        cpus: () => [{}, {}],
        default: { cpus: () => [{}, {}] },
      }));

      const mod = await import('../features/index-codebase.js');
      CodebaseIndexer = mod.CodebaseIndexer;
      handleToolCall = mod.handleToolCall;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('targets worker init timeout and error paths (lines 120-153)', async () => {
      let workerCount = 0;
      const workers = [];
      vi.doMock('worker_threads', () => ({
        Worker: vi.fn(function () {
          const w = new SafeMockWorker();
          workers.push(w);
          workerCount++;
          if (workerCount === 1) {
            setTimeout(() => w.emit('message', { type: 'ready' }), 10);
          } else {
            setTimeout(() => w.emit('message', { type: 'error', error: 'boom' }), 10);
          }
          return w;
        }),
      }));

      const { CodebaseIndexer: LocalIndexer } = await import('../features/index-codebase.js');
      const indexer = new LocalIndexer(
        vi.fn(),
        {},
        {
          workerThreads: 2,
          verbose: true,
          embeddingModel: 'test',
        }
      );

      await indexer.initializeWorkers();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Worker initialization failed')
      );
      expect(indexer.workers.length).toBe(0);
    });

    it('targets processChunksWithWorkers error/crash paths (lines 230-250)', async () => {
      const worker = new SafeMockWorker();
      const indexer = new CodebaseIndexer(vi.fn(), {}, { verbose: true });
      indexer.workers = [worker];

      // Setup postMessage to emit result for p1
      worker.postMessage.mockImplementationOnce((msg) => {
        setTimeout(() => {
          worker.emit('message', {
            type: 'error',
            error: 'msg_fail',
            batchId: msg.batchId,
          });
        }, 10);
      });

      const p1 = indexer.processChunksWithWorkers([{ text: 'a' }]);
      await p1;
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Worker 0 error'));

      // Setup for p2 (crash)
      worker.postMessage.mockImplementationOnce(() => {
        setTimeout(() => {
          worker.emit('error', new Error('crashed'));
        }, 10);
      });

      const p2 = indexer.processChunksWithWorkers([{ text: 'b' }]);
      await p2;
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Worker 0 crashed'));
    });

    it('targets setupFileWatcher closing existing (line 780)', async () => {
      const indexer = new CodebaseIndexer(
        vi.fn(),
        {},
        {
          watchFiles: true,
          fileExtensions: ['js'],
        }
      );
      const mockWatcher = { close: vi.fn().mockResolvedValue(true) };
      indexer.watcher = mockWatcher;
      await indexer.setupFileWatcher();
      expect(mockWatcher.close).toHaveBeenCalled();
    });

    it('targets preFilterFiles directory skip (line 465)', async () => {
      const indexer = new CodebaseIndexer(
        vi.fn(),
        { getFileHash: () => null },
        { maxFileSize: 100 }
      );
      vi.mocked(fs.stat).mockResolvedValue({
        isDirectory: () => true,
        size: 0,
      });
      const result = await indexer.preFilterFiles(['dir']);
      expect(result.length).toBe(0);
    });
  });
});
