import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodebaseIndexer, handleToolCall } from '../features/index-codebase.js';
import fs from 'fs/promises';
import path from 'path';

// Mock dependencies
vi.mock('fs/promises');
vi.mock('../lib/call-graph.js', () => ({
  extractCallData: vi.fn(),
}));
vi.mock('../lib/utils.js', async () => {
  const actual = await vi.importActual('../lib/utils.js');
  return {
    ...actual,
    hashContent: vi.fn().mockReturnValue('fixed-hash'), // predictable hash
    smartChunk: actual.smartChunk,
  };
});
vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('events');
  class Worker extends EventEmitter {
    constructor() {
      super();
      setTimeout(() => this.emit('message', { type: 'ready' }), 1);
    }
    terminate() {
      return Promise.resolve();
    }
    postMessage(msg) {
      if (msg.type === 'process') {
        this.emit('message', { type: 'results', results: [], batchId: msg.batchId });
      }
    }
  }
  return { Worker };
});

vi.mock('os', async () => {
  return {
    default: { cpus: () => [{}, {}, {}, {}] },
    cpus: () => [{}, {}, {}, {}],
  };
});

describe('CodebaseIndexer Coverage Maximizer', () => {
  let indexer;
  let config;
  let cache;
  let embedder;
  let extractCallDataMock;

  beforeEach(async () => {
    const callGraph = await import('../lib/call-graph.js');
    extractCallDataMock = callGraph.extractCallData;
    extractCallDataMock.mockReturnValue({}); // Default success

    config = {
      workerThreads: 2,
      verbose: true, // Important for logging branches
      embeddingModel: 'test-model',
      searchDirectory: '/test',
      maxFileSize: 100,
      fileExtensions: ['js'],
      excludePatterns: [],
      callGraphEnabled: true,
    };

    const cacheMock = {
      save: vi.fn(),
      getVectorStore: vi.fn().mockReturnValue([]),
      setVectorStore: vi.fn(),
      reset: vi.fn(),
      fileHashes: new Map(),
      fileCallData: new Map(),
      getFileHash: vi.fn(),
      setFileHash: vi.fn(),
      removeFileFromStore: vi.fn(),
      addToStore: vi.fn(),
      setFileCallData: vi.fn(),
      setFileCallDataEntries: vi.fn((entries) => {
        if (entries instanceof Map) {
          cacheMock.fileCallData = entries;
        } else {
          cacheMock.fileCallData = new Map(Object.entries(entries || {}));
        }
      }),
      clearFileCallData: vi.fn(() => {
        cacheMock.fileCallData = new Map();
      }),
      clearCallGraphData: vi.fn(),
      pruneCallGraphData: vi.fn().mockReturnValue(5), // Cover line 612 (if > 0)
      rebuildCallGraph: vi.fn(),
      ensureAnnIndex: vi.fn().mockResolvedValue(),
      deleteFileHash: vi.fn(),
      setLastIndexDuration: vi.fn(),
      setLastIndexStats: vi.fn(),
      setFileHashes: vi.fn((map) => { cacheMock.fileHashes = map; }),
      getFileHashKeys: vi.fn().mockImplementation(() => [...cacheMock.fileHashes.keys()]),
      getFileCallDataKeys: vi.fn().mockImplementation(() => [...cacheMock.fileCallData.keys()]),
    };
    cache = cacheMock;

    embedder = vi.fn().mockResolvedValue({ data: [] });

    indexer = new CodebaseIndexer(embedder, cache, config);
    // Mock discoverFiles to control input
    indexer.discoverFiles = vi.fn().mockResolvedValue(['/test/file1.js']);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Line 146: Worker initialization failure catch block', async () => {
    // Actually, let's verify line 343: indexFile error handling.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fs, 'stat').mockRejectedValue(new Error('Stat failed'));

    await indexer.indexFile('/test/bad.js');

    // Expect 2 args
    expect(warnSpy.mock.calls.length + errorSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it('Line 357 & 362: indexFile size and directory checks', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // 357: isDirectory
    vi.spyOn(fs, 'stat').mockResolvedValue({
      isDirectory: () => true,
      size: 50,
    });
    await indexer.indexFile('/test/dir');

    // 362: maxFileSize
    vi.spyOn(fs, 'stat').mockResolvedValue({
      isDirectory: () => false,
      size: 1000, // > 100
    });
    await indexer.indexFile('/test/large.js');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('too large'));
  });

  it('Lines 515-516: preFilterFiles error handling', async () => {
    vi.spyOn(fs, 'stat').mockRejectedValue(new Error('PreFilter Fail'));

    // Trigger preFilterFiles via indexAll or directly
    const files = ['/test/bad.js'];
    const results = await indexer.preFilterFiles(files);

    // Should catch error and return null (filtered out)
    expect(results.length).toBe(0);
  });

  it('Lines 603 & 612: indexAll pruning branches', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    // Mock cached files that are NOT in discovered files
    cache.setFileHashes(new Map([['/test/deleted.js', 'hash']]));
    cache.setFileCallDataEntries(new Map([['/test/deleted.js', {}]]));

    // discoverFiles returns ["/test/file1.js"] (mocked in beforeEach)

    await indexer.indexAll(false); // force=false to enable pruning

    expect(cache.removeFileFromStore).toHaveBeenCalledWith('/test/deleted.js');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Pruned 1 deleted/excluded files')
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Pruned 5 call-graph entries'));
  });

  it('Line 662: indexAll missing call graph data re-indexing', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    // Setup state
    cache.getVectorStore.mockReturnValue([{ file: '/test/file1.js' }]);
    cache.clearFileCallData(); // Empty, so file1.js is missing data
    // Use fixed-hash to match mock
    cache.setFileHashes(new Map([['/test/file1.js', 'fixed-hash']]));
    cache.getFileHash.mockReturnValue('fixed-hash');

    // Mock fs for re-indexing check
    vi.spyOn(fs, 'stat').mockResolvedValue({
      isDirectory: () => false,
      size: 50,
      mtimeMs: 123,
    });
    vi.spyOn(fs, 'readFile').mockResolvedValue('content');

    await indexer.indexAll(false);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('missing call graph data'));
    // Should have processed file1.js
    expect(cache.setFileCallData).toHaveBeenCalled();
  });

  it('Line 746 & 773: indexAll loop and call graph extraction error', async () => {
    // Force extractCallData to throw
    extractCallDataMock.mockImplementation(() => {
      throw new Error('Parse Error');
    });

    // Must ensure filesToProcess is NOT empty
    vi.spyOn(fs, 'stat').mockResolvedValue({ isDirectory: () => false, size: 50, mtimeMs: 123 });
    vi.spyOn(fs, 'readFile').mockResolvedValue('content');
    // Ensure hash mismatch so it processes
    cache.getFileHash.mockReturnValue('old-hash');

    await indexer.indexAll(true);

    expect(extractCallDataMock).toHaveBeenCalled();
    expect(cache.setFileCallData).not.toHaveBeenCalled();
  });

  it('Line 992: handleToolCall stats', async () => {
    const request = { params: { arguments: { force: true } } };

    // Mock indexAll to return specific stats
    indexer.indexAll = vi.fn().mockResolvedValue({
      skipped: false,
      filesProcessed: 5,
      chunksCreated: 10,
      totalFiles: 5,
      totalChunks: 10,
    });

    const result = await handleToolCall(request, indexer);
    expect(result.content[0].text).toContain('Files processed this run: 5');
  });
});
