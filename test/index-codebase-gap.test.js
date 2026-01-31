import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodebaseIndexer } from '../features/index-codebase.js';
import * as utils from '../lib/utils.js';
import fs from 'fs/promises';

// Mock dependencies
vi.mock('fs/promises');

// Mock helpers
vi.mock('../lib/utils.js', async () => {
  const actual = await vi.importActual('../lib/utils.js');
  return {
    ...actual,
    hashContent: vi.fn(),
    smartChunk: vi.fn().mockReturnValue([]),
  };
});

// Mock os.cpus (single threaded for simplicity in these tests)
vi.mock('os', async () => ({
  default: {
    cpus: () => [{}],
  },
}));

// Mock Chokidar
const mockWatcher = {
  on: vi.fn().mockReturnThis(),
  close: vi.fn().mockResolvedValue(undefined),
};
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => mockWatcher),
  },
}));

describe('CodebaseIndexer Gap Coverage', () => {
  let indexer;
  let mockEmbedder;
  let mockCache;
  let mockConfig;
  let mockServer;

  beforeEach(() => {
    vi.restoreAllMocks();
    
    // Default mocks
    mockEmbedder = vi.fn().mockResolvedValue({ data: [0.1] });
    
    mockCache = {
      getFileHash: vi.fn(),
      setFileHash: vi.fn(),
      removeFileFromStore: vi.fn(),
      addToStore: vi.fn(),
      deleteFileHash: vi.fn(),
      save: vi.fn(),
      clearCallGraphData: vi.fn(),
      getVectorStore: vi.fn().mockReturnValue([]),
      setVectorStore: vi.fn(),
      ensureAnnIndex: vi.fn().mockResolvedValue(null),
      pruneCallGraphData: vi.fn(),
      fileCallData: new Map(),
      fileHashes: new Map(),
      rebuildCallGraph: vi.fn(),
      setFileCallData: vi.fn(),
      getFileHashKeys: vi.fn().mockReturnValue([]),
      getFileCallDataKeys: vi.fn().mockImplementation(() => [...mockCache.fileCallData.keys()]),
    };

    mockConfig = {
      searchDirectory: '/test',
      fileExtensions: ['js'],
      fileNames: [],
      excludePatterns: [],
      maxFileSize: 1024, // Small max size for testing
      batchSize: 10,
      verbose: true, // IMPORTANT: Must be true for these tests
      callGraphEnabled: false,
      watchFiles: true,
      workerThreads: 1,
    };

    mockServer = {
      hybridSearch: {
        clearFileModTime: vi.fn(),
      },
      sendNotification: vi.fn(),
    };

    indexer = new CodebaseIndexer(mockEmbedder, mockCache, mockConfig, mockServer);
    
    // Silence console.warn/log but track calls
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  // Coverage for lines 825-837: Content provided but too large, or stat error
  it('logs verbose message and skips when content provided is too large', async () => {
    const largeContent = 'x'.repeat(2048); // > 1024
    
    indexer.discoverFiles = vi.fn().mockResolvedValue(['/test/large.js']);
    indexer.preFilterFiles = vi.fn().mockResolvedValue([
      { file: '/test/large.js', content: largeContent, hash: 'abc', force: false }
    ]);
    
    await indexer.indexAll();
    
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipped large.js (too large:')
    );
  });

  it('logs verbose message when fs.stat fails (if content not provided)', async () => {
    indexer.discoverFiles = vi.fn().mockResolvedValue(['/test/error.js']);
    // content is undefined so it tries fs.stat
    indexer.preFilterFiles = vi.fn().mockResolvedValue([
      { file: '/test/error.js', content: undefined, hash: undefined, force: false }
    ]);
    
    vi.spyOn(fs, 'stat').mockRejectedValue(new Error('Stat fail'));
    
    await indexer.indexAll();
    
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to stat error.js: Stat fail')
    );
  });

  // Coverage for line 846: Invalid stat result
  it('logs verbose message when stat result is invalid', async () => {
    indexer.discoverFiles = vi.fn().mockResolvedValue(['/test/weird.js']);
    indexer.preFilterFiles = vi.fn().mockResolvedValue([
      { file: '/test/weird.js', content: undefined, hash: undefined, force: false }
    ]);
    
    // Return mock object that is not a directory function or null
    vi.spyOn(fs, 'stat').mockResolvedValue(null);
    
    await indexer.indexAll();
    
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid stat result for weird.js')
    );
  });

  // Coverage for lines 859-870: File too large via stat, or read error
  it('logs verbose message when file is too large via stat', async () => {
    indexer.discoverFiles = vi.fn().mockResolvedValue(['/test/large_stat.js']);
    indexer.preFilterFiles = vi.fn().mockResolvedValue([
      { file: '/test/large_stat.js', content: undefined, hash: undefined, force: false }
    ]);
    
    vi.spyOn(fs, 'stat').mockResolvedValue({
      isDirectory: () => false,
      size: 2048, // > 1024
      mtimeMs: 123
    });
    
    await indexer.indexAll();
    
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipped large_stat.js (too large:')
    );
  });

  it('logs verbose message when fs.readFile fails', async () => {
    indexer.discoverFiles = vi.fn().mockResolvedValue(['/test/read_fail.js']);
    indexer.preFilterFiles = vi.fn().mockResolvedValue([
      { file: '/test/read_fail.js', content: undefined, hash: undefined, force: false }
    ]);
    
    vi.spyOn(fs, 'stat').mockResolvedValue({
      isDirectory: () => false,
      size: 100,
      mtimeMs: 123
    });
    vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('Read error'));
    
    await indexer.indexAll();
    
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read read_fail.js: Read error')
    );
  });

  // Coverage for line 882: Unchanged file logging
  it('logs verbose message when file is unchanged (hash match)', async () => {
    indexer.discoverFiles = vi.fn().mockResolvedValue(['/test/same.js']);
    indexer.preFilterFiles = vi.fn().mockResolvedValue([
      { file: '/test/same.js', content: undefined, hash: undefined, force: false }
    ]);
    
    vi.spyOn(fs, 'stat').mockResolvedValue({
      isDirectory: () => false,
      size: 100,
      mtimeMs: 123
    });
    vi.spyOn(fs, 'readFile').mockResolvedValue('content');
    
    vi.spyOn(utils, 'hashContent').mockReturnValue('the-hash');
    mockCache.getFileHash.mockReturnValue('the-hash');
    
    await indexer.indexAll();
    
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipped same.js (unchanged)')
    );
  });

  // Coverage for lines 1106, 1126, 1146: Watcher events during indexing
  it('logs verbose messages when queuing watch events during indexing', async () => {
    // 1. Setup watcher
    await indexer.setupFileWatcher();
    
    // Get the handlers
    const addHandler = mockWatcher.on.mock.calls.find(c => c[0] === 'add')[1];
    const changeHandler = mockWatcher.on.mock.calls.find(c => c[0] === 'change')[1];
    const unlinkHandler = mockWatcher.on.mock.calls.find(c => c[0] === 'unlink')[1];
    
    // 2. Set indexing state
    indexer.isIndexing = true;
    
    // 3. Trigger events
    await addHandler('new.js');
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('Queued add event during indexing')
    );
    
    await changeHandler('changed.js');
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('Queued change event during indexing')
    );
    
    await unlinkHandler('deleted.js');
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('Queued delete event during indexing')
    );
  });
});

