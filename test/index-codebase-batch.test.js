import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import { smartChunk, hashContent } from '../lib/utils.js';

vi.mock('os', () => ({
  default: { cpus: () => [{}] },
  cpus: () => [{}],
}));
vi.mock('fs/promises');
vi.mock('../lib/utils.js', () => ({
  smartChunk: vi.fn(),
  hashContent: vi.fn(),
}));

const createCache = () => ({
  removeFileFromStore: vi.fn(),
  deleteFileHash: vi.fn(),
  setFileHash: vi.fn(),
  addToStore: vi.fn(),
  setVectorStore: vi.fn(),
  getVectorStore: vi.fn().mockReturnValue([]),
  pruneCallGraphData: vi.fn().mockReturnValue(0),
  clearCallGraphData: vi.fn(),
  save: vi.fn().mockResolvedValue(undefined),
  rebuildCallGraph: vi.fn(),
  ensureAnnIndex: vi.fn().mockResolvedValue(null),
  fileHashes: new Map(),
  fileCallData: new Map(),
  getFileHashKeys() {
    return Array.from(this.fileHashes.keys());
  },
  getFileHashCount() {
    return this.fileHashes.size;
  },
  clearFileHashes() {
    this.fileHashes.clear();
  },
  getFileCallDataKeys() {
    return Array.from(this.fileCallData.keys());
  },
  getFileCallDataCount() {
    return this.fileCallData.size;
  },
  clearFileCallData() {
    this.fileCallData.clear();
  },
  setFileCallData: vi.fn(),
});

describe('CodebaseIndexer batch processing presets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('coerces preset content and skips oversized batches', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 1,
      maxFileSize: 1,
      callGraphEnabled: false,
      verbose: true,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);
    indexer.discoverFiles = vi.fn().mockResolvedValue(['/root/a.js']);
    indexer.preFilterFiles = vi
      .fn()
      .mockResolvedValue([{ file: '/root/a.js', content: 12345 }]);

    hashContent.mockReturnValueOnce('hash');

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await indexer.indexAll(false);

    expect(hashContent).toHaveBeenCalledWith('12345');
    const hasSkip = consoleSpy.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('Skipped a.js (too large')
    );
    expect(hasSkip).toBe(true);

    consoleSpy.mockRestore();
  });

  it('logs stat errors when preset content is missing', async () => {
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const cache = createCache();
    const config = {
      searchDirectory: '/root',
      excludePatterns: [],
      fileExtensions: ['js'],
      fileNames: [],
      batchSize: 1,
      maxFileSize: 100,
      callGraphEnabled: false,
      verbose: true,
    };
    const indexer = new CodebaseIndexer(vi.fn(), cache, config);
    indexer.discoverFiles = vi.fn().mockResolvedValue(['/root/b.js']);
    indexer.preFilterFiles = vi.fn().mockResolvedValue([{ file: '/root/b.js' }]);

    fs.stat.mockRejectedValueOnce(new Error('stat fail'));

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await indexer.indexAll(false);

    const hasStatError = consoleSpy.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('Failed to stat')
    );
    expect(hasStatError).toBe(true);

    consoleSpy.mockRestore();
  });
});
