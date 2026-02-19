import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CodebaseIndexer, handleToolCall } from '../features/index-codebase.js';
import { EventEmitter } from 'events';
import fs from 'fs/promises';

vi.mock('fs/promises');
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      close: vi.fn().mockResolvedValue(true),
    })),
  },
}));


class MockWorker extends EventEmitter {
  constructor() {
    super();
    this.postMessage = vi.fn((msg) => {
      if (msg.type === 'process') {
        
        setTimeout(() => {
          this.emit('message', {
            type: 'results',
            batchId: msg.batchId,
            results: msg.chunks.map((c) => ({
              ...c,
              success: true,
              vector: [0.1],
            })),
          });
        }, 0);
      } else if (msg.type === 'shutdown') {
        this.emit('exit', 0);
      }
    });
    this.terminate = vi.fn().mockResolvedValue(0);
    this.threadId = Math.random();
  }
  off = this.removeListener;
}

describe('CodebaseIndexer Detailed Coverage', () => {
  let indexer;
  let mockEmbedder;
  let mockCache;
  let config;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbedder = vi.fn().mockResolvedValue({ data: [1, 2, 3] });
    mockCache = {
      getVectorStore: vi.fn().mockReturnValue([]),
      getFileHash: vi.fn(),
      setFileHash: vi.fn(),
      addToStore: vi.fn(),
      removeFileFromStore: vi.fn(),
      pruneCallGraphData: vi.fn().mockReturnValue(0),
      save: vi.fn().mockResolvedValue(true),
      rebuildCallGraph: vi.fn(),
      ensureAnnIndex: vi.fn().mockResolvedValue({}),
      fileCallData: new Map(),
      getFileHashKeys: vi.fn().mockReturnValue([]),
    };
    config = {
      searchDirectory: '/root',
      embeddingModel: 'test',
      fileExtensions: ['js'],
      watchFiles: true,
      verbose: true,
      workerThreads: 2,
    };
    indexer = new CodebaseIndexer(mockEmbedder, mockCache, config);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('Watcher Gaps', () => {
    it('covers setupFileWatcher patterns (lines 784-794)', async () => {
      indexer.config.fileNames = ['config.json'];
      await indexer.setupFileWatcher();
      expect(indexer.watcher).toBeDefined();
      await indexer.terminateWorkers(); 
    });
  });

  describe('Tool Call Gaps', () => {
    it('covers handleToolCall statistics (lines 894-896)', async () => {
      const result = {
        skipped: false,
        totalFiles: 1,
        totalChunks: 5,
        filesProcessed: 1,
        chunksCreated: 5,
        message: 'Done',
      };
      const mockIndexer = {
        indexAll: vi.fn().mockResolvedValue(result),
        cache: mockCache,
      };
      const request = { params: { arguments: { force: true } } };
      const response = await handleToolCall(request, mockIndexer);

      expect(response.content[0].text).toContain('Files processed this run: 1');
      expect(response.content[0].text).toContain('Chunks created this run: 5');
    });
  });

  describe('Worker Lifecycle Gaps (Non-hanging)', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it('covers worker creation and ready flow (lines 110-143)', async () => {
      
      vi.doMock('os', () => ({
        default: { cpus: () => [{}, {}, {}, {}] },
        cpus: () => [{}, {}, {}, {}],
      }));

      
      vi.doMock('worker_threads', () => ({
        Worker: vi.fn(function () {
          const w = new MockWorker();
          
          setTimeout(() => w.emit('message', { type: 'ready' }), 10);
          return w;
        }),
      }));

      const { CodebaseIndexer } = await import('../features/index-codebase.js');
      const localIndexer = new CodebaseIndexer(mockEmbedder, mockCache, config);

      await localIndexer.initializeWorkers();
      expect(localIndexer.workers.length).toBe(2);

      await localIndexer.terminateWorkers();
      expect(localIndexer.workers.length).toBe(0);
    });

    it('covers worker processing with recovery (lines 197-283)', async () => {
      const worker = new MockWorker();
      
      indexer.workers = [worker];
      const chunks = [{ file: 'a.js', text: 'code' }];

      const results = await indexer.processChunksWithWorkers(chunks);
      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);
    });

    it('covers worker initialization failure (lines 151-154)', async () => {
      vi.doMock('worker_threads', () => ({
        Worker: vi.fn(function () {
          const w = new MockWorker();
          
          setTimeout(() => w.emit('error', new Error('Init fail')), 10);
          return w;
        }),
      }));

      const { CodebaseIndexer } = await import('../features/index-codebase.js');
      const localIndexer = new CodebaseIndexer(mockEmbedder, mockCache, {
        ...config,
        workerThreads: 1,
      }); 
      localIndexer.config.workerThreads = 2;

      await localIndexer.initializeWorkers();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Worker initialization failed')
      );
      expect(localIndexer.workers.length).toBe(0);
    });
  });
});
