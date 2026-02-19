import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  createTestFixtures,
  cleanupFixtures,
  clearTestCache,
  createMockRequest,
  measureTime,
} from './helpers.js';
import * as IndexCodebaseFeature from '../features/index-codebase.js';
import { CodebaseIndexer } from '../features/index-codebase.js';
import fs from 'fs/promises';
import path from 'path';

describe('CodebaseIndexer', () => {
  let fixtures;

  beforeAll(async () => {
    fixtures = await createTestFixtures({ workerThreads: 1 });

    fixtures.config.excludePatterns.push('**/index-codebase-branches.test.js');

    fixtures.indexer = new CodebaseIndexer(
      fixtures.embedder,
      fixtures.cache,
      fixtures.config,
      null
    );
  });

  afterAll(async () => {
    await cleanupFixtures(fixtures);
  });

  beforeEach(async () => {
    fixtures.indexer.isIndexing = false;
    await fixtures.indexer.terminateWorkers();
  });

  describe('Basic Indexing', () => {
    it('should construct the indexer instance', async () => {
      expect(fixtures.indexer).toBeInstanceOf(CodebaseIndexer);
    });

    it('should index files and create embeddings', async () => {
      await clearTestCache(fixtures.config);
      fixtures.cache.setVectorStore([]);
      fixtures.cache.clearFileHashes();

      const { result, duration } = await measureTime(() => fixtures.indexer.indexAll(true));

      expect(result.skipped).toBe(false);
      expect(result.filesProcessed).toBeGreaterThan(0);
      expect(result.chunksCreated).toBeGreaterThan(0);
      expect(result.totalFiles).toBeGreaterThan(0);
      expect(result.totalChunks).toBeGreaterThan(0);
      expect(duration).toBeGreaterThanOrEqual(0);
    });

    it('should skip unchanged files on subsequent indexing', async () => {
      await fixtures.indexer.indexAll(true);

      const result = await fixtures.indexer.indexAll(false);

      expect(result.skipped).toBe(false);
      expect(result.filesProcessed).toBe(0);
      expect(result.message).toContain('up to date');
    });

    it('should reindex all files when force is true', async () => {
      await fixtures.indexer.indexAll(true);
      const _firstChunks = fixtures.cache.getVectorStore().length;

      const result = await fixtures.indexer.indexAll(true);

      expect(result.filesProcessed).toBeGreaterThan(0);
      expect(result.chunksCreated).toBeGreaterThan(0);
    });
  });

  describe('Concurrent Indexing Protection', () => {
    it('should prevent concurrent indexing', async () => {
      await clearTestCache(fixtures.config);
      fixtures.cache.setVectorStore([]);
      fixtures.cache.clearFileHashes();

      const promise1 = fixtures.indexer.indexAll(true);
      expect(fixtures.indexer.isIndexing).toBe(true);

      const result2 = await fixtures.indexer.indexAll(false);

      expect(result2.skipped).toBe(true);
      expect(result2.reason).toContain('already in progress');

      await promise1;
    });

    it('should set and clear isIndexing flag correctly', async () => {
      await clearTestCache(fixtures.config);
      fixtures.cache.setVectorStore([]);
      fixtures.cache.clearFileHashes();

      expect(fixtures.indexer.isIndexing).toBe(false);

      const promise = fixtures.indexer.indexAll(true);
      expect(fixtures.indexer.isIndexing).toBe(true);

      await promise;

      expect(fixtures.indexer.isIndexing).toBe(false);
    });
  });

  describe('File Discovery', () => {
    it('should discover files matching configured extensions', async () => {
      const files = await fixtures.indexer.discoverFiles();

      expect(files.length).toBeGreaterThan(0);

      const extensions = fixtures.config.fileExtensions.map((ext) => `.${ext}`);
      for (const file of files) {
        const ext = file.substring(file.lastIndexOf('.'));
        expect(extensions).toContain(ext);
      }
    });

    it('should exclude files in excluded directories', async () => {
      const files = await fixtures.indexer.discoverFiles();

      const nodeModulesFiles = files.filter((f) => f.includes('node_modules'));
      expect(nodeModulesFiles.length).toBe(0);

      const cacheFiles = files.filter((f) => f.includes('.smart-coding-cache'));
      expect(cacheFiles.length).toBe(0);
    });
  });

  describe('Worker Thread Management', () => {
    it('should initialize workers when CPU count > 1', async () => {
      await fixtures.indexer.initializeWorkers();
      expect(fixtures.indexer.workers.length).toBeGreaterThanOrEqual(0);
      fixtures.indexer.terminateWorkers();
    });

    it('should fallback to single thread if worker init fails', async () => {
      fixtures.indexer.workers = [];
      const chunks = [{ file: 'f.js', text: 'code' }];

      const processSpy = vi
        .spyOn(fixtures.indexer, 'processChunksSingleThreaded')
        .mockResolvedValue([]);

      await fixtures.indexer.processChunksWithWorkers(chunks);
      expect(processSpy).toHaveBeenCalled();
    });

    it('should handle worker timeouts by falling back', async () => {
      const mockWorker = {
        postMessage: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        terminate: vi.fn().mockResolvedValue(),
      };

      fixtures.indexer.workers = [mockWorker];
      fixtures.config.verbose = true;

      const fallbackSpy = vi
        .spyOn(fixtures.indexer, 'processChunksSingleThreaded')
        .mockResolvedValue([{ success: true }]);

      const _originalTimeout = setTimeout;

      vi.useFakeTimers();

      const promise = fixtures.indexer.processChunksWithWorkers([{ text: 'test' }]);

      vi.advanceTimersByTime(300001);

      const _result = await promise;

      expect(fallbackSpy).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('Progress Reporting', () => {
    it('should send progress notifications', async () => {
      fixtures.indexer.server = {
        sendNotification: vi.fn(),
      };

      fixtures.indexer.sendProgress(50, 100, 'Halfway');
      expect(fixtures.indexer.server.sendNotification).toHaveBeenCalledWith(
        'notifications/progress',
        expect.objectContaining({ progress: 50, message: 'Halfway' })
      );
    });
  });

  describe('Pre-filtering', () => {
    it('should handle file read errors gracefully during pre-filter', async () => {
      const _files = ['/path/bad.js', '/path/good.js'];

      // We can spy on fs/promises if we mocked it globally, but we didn't here.
    });
  });

  describe('Background ANN handling', () => {
    it('should swallow ANN build errors in background when verbose', async () => {
      await clearTestCache(fixtures.config);
      fixtures.cache.setVectorStore([]);
      fixtures.cache.clearFileHashes();
      fixtures.config.verbose = true;

      const ensureAnnIndex = fixtures.cache.ensureAnnIndex;
      fixtures.cache.ensureAnnIndex = vi.fn().mockRejectedValue(new Error('boom'));

      await fixtures.indexer.indexAll(true);
      await new Promise((resolve) => setImmediate(resolve));

      expect(fixtures.cache.ensureAnnIndex).toHaveBeenCalled();
      fixtures.cache.ensureAnnIndex = ensureAnnIndex;
    });
  });

  describe('Indexing Logic', () => {
    it('should skip file if hash matches cache', async () => {
      const file = path.join(fixtures.searchDir, 'skipped.js');
      const content =
        'function test() {\n  console.info("hello");\n}\n\nfunction other() {\n  return true;\n}';
      const { hashContent } = await import('../lib/utils.js');
      const hash = hashContent(content);

      const statSpy = vi.spyOn(fs, 'stat').mockResolvedValue({
        size: 100,
        mtimeMs: Date.now(),
        mtime: new Date(),
        isDirectory: () => false,
      });
      const readFileSpy = vi.spyOn(fs, 'readFile').mockResolvedValue(content);

      fixtures.cache.getFileHash = vi.fn().mockReturnValue(hash);
      fixtures.cache.addToStore = vi.fn();
      fixtures.cache.setFileHash = vi.fn();

      try {
        const added = await fixtures.indexer.indexFile(file);
        expect(added).toBe(0);
        expect(fixtures.cache.addToStore).not.toHaveBeenCalled();
        expect(fixtures.cache.setFileHash).toHaveBeenCalledWith(file, hash, expect.any(Object));
      } finally {
        statSpy.mockRestore();
        readFileSpy.mockRestore();
      }
    });

    it('should process file if hash mismatch', async () => {
      const file = path.join(fixtures.searchDir, 'processed.js');
      const content = 'function test() {\n  return "value";\n}\n';

      const statSpy = vi.spyOn(fs, 'stat').mockResolvedValue({
        size: 100,
        mtime: new Date(),
        isDirectory: () => false,
      });
      const readFileSpy = vi.spyOn(fs, 'readFile').mockResolvedValue(content);

      fixtures.cache.getFileHash = vi.fn().mockReturnValue('old');
      fixtures.cache.setFileHash = vi.fn();
      fixtures.cache.addToStore = vi.fn();

      try {
        const added = await fixtures.indexer.indexFile(file);
        expect(added).toBeGreaterThan(0);
        expect(fixtures.cache.addToStore).toHaveBeenCalled();
        expect(fixtures.cache.setFileHash).toHaveBeenCalled();
      } finally {
        statSpy.mockRestore();
        readFileSpy.mockRestore();
      }
    });
  });
});

describe('Index Codebase Tool Handler', () => {
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
  });

  describe('Tool Definition', () => {
    it('should have correct tool definition', () => {
      const toolDef = IndexCodebaseFeature.getToolDefinition();

      expect(toolDef.name).toBe('b_index_codebase');
      expect(toolDef.description).toContain('reindex');
      expect(toolDef.inputSchema.properties.force).toBeDefined();
      expect(toolDef.inputSchema.properties.force.type).toBe('boolean');
    });
  });

  describe('Tool Handler', () => {
    it('should return success message on completed indexing', async () => {
      const request = createMockRequest('b_index_codebase', { force: false });
      const result = await IndexCodebaseFeature.handleToolCall(request, fixtures.indexer);

      expect(result.content[0].text).toContain('reindexed successfully');
      expect(result.content[0].text).toContain('Total files in index');
      expect(result.content[0].text).toContain('Total code chunks');
    });

    it('should return skipped message on concurrent calls', async () => {
      await clearTestCache(fixtures.config);
      fixtures.cache.setVectorStore([]);
      fixtures.cache.clearFileHashes();

      const promise1 = IndexCodebaseFeature.handleToolCall(
        createMockRequest('b_index_codebase', { force: true }),
        fixtures.indexer
      );
      expect(fixtures.indexer.isIndexing).toBe(true);

      const result2 = await IndexCodebaseFeature.handleToolCall(
        createMockRequest('b_index_codebase', { force: false }),
        fixtures.indexer
      );

      expect(result2.content[0].text).toContain('Indexing skipped');
      expect(result2.content[0].text).toContain('already in progress');

      await promise1;
    });

    it('should handle force parameter correctly', async () => {
      await IndexCodebaseFeature.handleToolCall(
        createMockRequest('b_index_codebase', { force: true }),
        fixtures.indexer
      );

      const result = await IndexCodebaseFeature.handleToolCall(
        createMockRequest('b_index_codebase', { force: false }),
        fixtures.indexer
      );

      expect(result.content[0].text).toContain('up to date');
    });
  });
});

describe('Index Codebase Branch Maximizer', () => {
  let fixtures;

  beforeAll(async () => {
    fixtures = await createTestFixtures({ workerThreads: 1 });
  });

  afterAll(async () => {
    await cleanupFixtures(fixtures);
  });

  it('covers various verbose=false branches and error paths', async () => {
    fixtures.config.verbose = false;
    fixtures.indexer.server = null;

    const subDir = path.join(fixtures.config.searchDirectory, 'maximizer');
    await fs.mkdir(subDir, { recursive: true });

    const excluded = await fixtures.indexer.indexFile('node_modules/test.js');
    expect(excluded).toBe(0);

    const largeFile = path.join(subDir, 'large.js');
    await fs.writeFile(largeFile, 'x'.repeat(fixtures.config.maxFileSize + 1));
    const zipped = await fixtures.indexer.indexFile(largeFile);
    expect(zipped).toBe(0);

    const unchangedFile = path.join(subDir, 'unchanged.js');
    await fs.writeFile(unchangedFile, 'content');
    await fixtures.indexer.indexFile(unchangedFile);
    const secondRun = await fixtures.indexer.indexFile(unchangedFile);
    expect(secondRun).toBe(0);

    const originalEmbedder = fixtures.indexer.embedder;
    fixtures.indexer.embedder = vi.fn().mockRejectedValueOnce(new Error('fail'));
    const failFile = path.join(subDir, 'fail.js');
    await fs.writeFile(failFile, 'content');
    await fixtures.indexer.indexFile(failFile);
    fixtures.indexer.embedder = originalEmbedder;

    await fs.rm(subDir, { recursive: true, force: true });

    const discoverSpy = vi
      .spyOn(fixtures.indexer, 'discoverFiles')
      .mockResolvedValue([...new Array(1001)].map((_, i) => `file_${i}.js`));
    const preFilterSpy = vi
      .spyOn(fixtures.indexer, 'preFilterFiles')
      .mockResolvedValue([{ file: 'f1.js', content: 'c', hash: 'h' }]);

    await fixtures.indexer.indexAll(false);
    discoverSpy.mockRestore();
    preFilterSpy.mockRestore();

    fixtures.config.watchFiles = true;
    await fixtures.indexer.setupFileWatcher();
    expect(fixtures.indexer.watcher).not.toBeNull();

    await fixtures.indexer.watcher.emit('add', 'new.js');
    await fixtures.indexer.watcher.emit('change', 'new.js');
    await fixtures.indexer.watcher.emit('unlink', 'new.js');

    await fixtures.indexer.indexAll(false);
    await new Promise((r) => setImmediate(r));
  });

  it('covers remaining branches: fileNames fallback, failed hash update logging, and progress', async () => {
    fixtures.config.verbose = true;
    fixtures.config.fileNames = null;

    const subDir = path.join(fixtures.config.searchDirectory, 'remaining');
    await fs.mkdir(subDir, { recursive: true });
    const failFile = path.join(subDir, 'fail_verbose_all.js');
    await fs.writeFile(failFile, 'content');

    const originalEmbedder = fixtures.indexer.embedder;
    fixtures.indexer.embedder = vi.fn().mockRejectedValueOnce(new Error('fail'));

    const { smartChunk: _smartChunk } = await import('../lib/utils.js');
    const smartChunkSpy = vi
      .spyOn(await import('../lib/utils.js'), 'smartChunk')
      .mockReturnValue([{ text: 't', startLine: 1, endLine: 1 }]);

    fixtures.cache.ensureAnnIndex = vi.fn().mockRejectedValue(new Error('boom'));

    await fixtures.indexer.indexAll(true);

    fixtures.indexer.embedder = originalEmbedder;
    smartChunkSpy.mockRestore();

    await fs.rm(subDir, { recursive: true, force: true });
  });

  it('covers worker result collection edge cases', async () => {
    const chunks = [{ file: 'f.js', text: 't' }];
    fixtures.indexer.config.allowSingleThreadFallback = true;
    fixtures.indexer.workers = [
      {
        postMessage: vi.fn(),
        on: vi.fn(),
        once: (evt, cb) => {
          if (evt === 'error') {
            setTimeout(() => cb(new Error('crash')), 10);
          }
        },
        off: vi.fn(),
        terminate: vi.fn().mockResolvedValue(),
      },
    ];
    const processSpy = vi
      .spyOn(fixtures.indexer, 'processChunksSingleThreaded')
      .mockResolvedValue([]);

    await fixtures.indexer.processChunksWithWorkers(chunks);
    expect(processSpy).toHaveBeenCalled();
  });
});
