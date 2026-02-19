

import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

vi.mock('chokidar', () => {
  const { EventEmitter } = require('events');
  const watch = vi.fn((patterns, options) => {
    const emitter = new EventEmitter();
    emitter.close = vi.fn().mockResolvedValue();
    const on = emitter.on.bind(emitter);
    emitter.on = (event, handler) => {
      on(event, handler);
      return emitter;
    };
    globalThis.__heuristicWatcher = emitter;
    globalThis.__heuristicWatcherOptions = options;
    return emitter;
  });

  return {
    __esModule: true,
    default: {
      watch,
    },
  };
});

import { CodebaseIndexer } from '../features/index-codebase.js';

async function withTempDir(testFn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heuristic-watcher-'));
  try {
    await testFn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('CodebaseIndexer watcher', () => {
  it('wires watcher events to indexing and cache updates', async () => {
    await withTempDir(async (dir) => {
      const config = {
        fileExtensions: ['js'],
        fileNames: [],
        searchDirectory: dir,
        excludePatterns: [],
        watchFiles: true,
        watchDebounceMs: 0,
        watchWriteStabilityMs: 0,
        enableCache: true,
        callGraphEnabled: false,
        embeddingModel: 'test',
        verbose: false,
      };

      const cache = {
        save: vi.fn().mockResolvedValue(),
        removeFileFromStore: vi.fn(),
        deleteFileHash: vi.fn(),
      };

      const server = {
        hybridSearch: {
          clearFileModTime: vi.fn(),
        },
      };

      const indexer = new CodebaseIndexer(async () => ({ data: [] }), cache, config, server);
      indexer.indexFile = vi.fn().mockResolvedValue();
      indexer.isIndexing = false;
      indexer.processingWatchEvents = false;

      await indexer.setupFileWatcher();

      const relPath = path.join('src', 'file.js');
      vi.useFakeTimers();
      indexer.watcher.emit('add', relPath);
      await vi.advanceTimersByTimeAsync(0);

      const fullPath = path.join(dir, relPath);
      if (indexer._watcherInProgress?.has(fullPath)) {
        await indexer._watcherInProgress.get(fullPath);
      }

      expect(indexer.indexFile).toHaveBeenCalledWith(fullPath);
      expect(cache.save).toHaveBeenCalled();
      expect(server.hybridSearch.clearFileModTime).toHaveBeenCalledWith(fullPath);

      indexer.watcher.emit('change', relPath);
      await vi.advanceTimersByTimeAsync(0);
      if (indexer._watcherInProgress?.has(fullPath)) {
        await indexer._watcherInProgress.get(fullPath);
      }
      expect(indexer.indexFile).toHaveBeenCalledTimes(2);

      indexer.watcher.emit('unlink', relPath);
      await vi.advanceTimersByTimeAsync(0);
      expect(cache.removeFileFromStore).toHaveBeenCalledWith(path.join(dir, relPath));
      expect(cache.deleteFileHash).toHaveBeenCalledWith(path.join(dir, relPath));
      vi.useRealTimers();
    });
  });

  it('closes existing watcher before reinitializing', async () => {
    await withTempDir(async (dir) => {
      const config = {
        fileExtensions: ['js'],
        fileNames: [],
        searchDirectory: dir,
        excludePatterns: [],
        watchFiles: true,
        enableCache: true,
        callGraphEnabled: false,
        embeddingModel: 'test',
        verbose: false,
      };

      const cache = {
        save: vi.fn().mockResolvedValue(),
        removeFileFromStore: vi.fn(),
        deleteFileHash: vi.fn(),
      };

      const indexer = new CodebaseIndexer(async () => ({ data: [] }), cache, config, null);
      indexer.indexFile = vi.fn().mockResolvedValue();

      await indexer.setupFileWatcher();
      const firstWatcher = globalThis.__heuristicWatcher;

      await indexer.setupFileWatcher();

      expect(firstWatcher.close).toHaveBeenCalledTimes(1);
      expect(globalThis.__heuristicWatcher).not.toBe(firstWatcher);
    });
  });

  it('queues change and unlink events during active indexing', async () => {
    await withTempDir(async (dir) => {
      const config = {
        fileExtensions: ['js'],
        fileNames: [],
        searchDirectory: dir,
        excludePatterns: [],
        watchFiles: true,
        enableCache: true,
        callGraphEnabled: false,
        embeddingModel: 'test',
        verbose: true,
      };

      const cache = {
        save: vi.fn().mockResolvedValue(),
        removeFileFromStore: vi.fn(),
        deleteFileHash: vi.fn(),
      };

      const indexer = new CodebaseIndexer(async () => ({ data: [] }), cache, config, null);
      indexer.indexFile = vi.fn().mockResolvedValue();
      indexer.isIndexing = true;

      const enqueueSpy = vi.spyOn(indexer, 'enqueueWatchEvent');

      await indexer.setupFileWatcher();

      const relPath = path.join('src', 'file.js');
      globalThis.__heuristicWatcher.emit('add', relPath);
      globalThis.__heuristicWatcher.emit('change', relPath);
      globalThis.__heuristicWatcher.emit('unlink', relPath);
      await flushPromises();

      expect(enqueueSpy).toHaveBeenCalledWith('add', path.join(dir, relPath));
      expect(enqueueSpy).toHaveBeenCalledWith('change', path.join(dir, relPath));
      expect(enqueueSpy).toHaveBeenCalledWith('unlink', path.join(dir, relPath));
      expect(indexer.indexFile).not.toHaveBeenCalled();
      expect(cache.save).not.toHaveBeenCalled();
    });
  });

  it('queues events without verbose logging when indexing', async () => {
    await withTempDir(async (dir) => {
      const config = {
        fileExtensions: ['js'],
        fileNames: [],
        searchDirectory: dir,
        excludePatterns: [],
        watchFiles: true,
        enableCache: true,
        callGraphEnabled: false,
        embeddingModel: 'test',
        verbose: false,
      };

      const cache = {
        save: vi.fn().mockResolvedValue(),
        removeFileFromStore: vi.fn(),
        deleteFileHash: vi.fn(),
      };

      const indexer = new CodebaseIndexer(async () => ({ data: [] }), cache, config, null);
      indexer.indexFile = vi.fn().mockResolvedValue();
      indexer.isIndexing = true;

      const enqueueSpy = vi.spyOn(indexer, 'enqueueWatchEvent');

      await indexer.setupFileWatcher();

      const relPath = path.join('src', 'file.js');
      globalThis.__heuristicWatcher.emit('add', relPath);
      globalThis.__heuristicWatcher.emit('change', relPath);
      globalThis.__heuristicWatcher.emit('unlink', relPath);
      await flushPromises();

      expect(enqueueSpy).toHaveBeenCalledWith('add', path.join(dir, relPath));
      expect(enqueueSpy).toHaveBeenCalledWith('change', path.join(dir, relPath));
      expect(enqueueSpy).toHaveBeenCalledWith('unlink', path.join(dir, relPath));
    });
  });

  it('processes pending watch events and clears hybrid search cache', async () => {
    await withTempDir(async (dir) => {
      const config = {
        fileExtensions: ['js'],
        fileNames: [],
        searchDirectory: dir,
        excludePatterns: [],
        watchFiles: true,
        enableCache: true,
        callGraphEnabled: false,
        embeddingModel: 'test',
        verbose: false,
      };

      const cache = {
        save: vi.fn().mockResolvedValue(),
        removeFileFromStore: vi.fn(),
        deleteFileHash: vi.fn(),
      };

      const server = {
        hybridSearch: {
          clearFileModTime: vi.fn(),
        },
      };

      const indexer = new CodebaseIndexer(async () => ({ data: [] }), cache, config, server);
      indexer.indexFile = vi.fn().mockResolvedValue();

      const changePath = path.join(dir, 'change.js');
      const unlinkPath = path.join(dir, 'unlink.js');
      indexer.pendingWatchEvents.set(changePath, 'change');
      indexer.pendingWatchEvents.set(unlinkPath, 'unlink');

      await indexer.processPendingWatchEvents();

      expect(server.hybridSearch.clearFileModTime).toHaveBeenCalledWith(changePath);
      expect(server.hybridSearch.clearFileModTime).toHaveBeenCalledWith(unlinkPath);
      expect(indexer.indexFile).toHaveBeenCalledWith(changePath);
      expect(cache.removeFileFromStore).toHaveBeenCalledWith(unlinkPath);
      expect(cache.deleteFileHash).toHaveBeenCalledWith(unlinkPath);
      expect(cache.save).toHaveBeenCalled();
    });
  });

  it('logs watcher ready and error events', async () => {
    await withTempDir(async (dir) => {
      const config = {
        fileExtensions: ['js'],
        fileNames: [],
        searchDirectory: dir,
        excludePatterns: [],
        watchFiles: true,
        enableCache: true,
        callGraphEnabled: false,
        embeddingModel: 'test',
        verbose: true,
      };

      const cache = {
        save: vi.fn().mockResolvedValue(),
        removeFileFromStore: vi.fn(),
        deleteFileHash: vi.fn(),
      };

      const indexer = new CodebaseIndexer(async () => ({ data: [] }), cache, config, null);
      indexer.indexFile = vi.fn().mockResolvedValue();

      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await indexer.setupFileWatcher();

      globalThis.__heuristicWatcher.emit('ready');
      globalThis.__heuristicWatcher.emit('error', new Error('watcher failed'));
      await flushPromises();

      expect(infoSpy).toHaveBeenCalledWith(
        '[Indexer] File watcher ready and monitoring for changes'
      );
      expect(errorSpy).toHaveBeenCalledWith('[Indexer] File watcher error: watcher failed');

      infoSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  it('throttles ignored path logging', async () => {
    await withTempDir(async (dir) => {
      const config = {
        fileExtensions: ['js'],
        fileNames: [],
        searchDirectory: dir,
        excludePatterns: [],
        watchFiles: true,
        enableCache: true,
        callGraphEnabled: false,
        embeddingModel: 'test',
        verbose: true,
      };

      const cache = {
        save: vi.fn().mockResolvedValue(),
        removeFileFromStore: vi.fn(),
        deleteFileHash: vi.fn(),
      };

      const indexer = new CodebaseIndexer(async () => ({ data: [] }), cache, config, null);
      indexer.indexFile = vi.fn().mockResolvedValue();
      indexer.isExcluded = vi.fn().mockReturnValue(true);

      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      vi.useFakeTimers();
      const baseTime = new Date('2026-01-31T00:00:00Z');
      vi.setSystemTime(baseTime);

      await indexer.setupFileWatcher();
      const { ignored } = globalThis.__heuristicWatcherOptions;

      for (let i = 0; i < 6; i += 1) {
        ignored(`src/ignored-${i}.js`);
      }

      const ignoredLogs = infoSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].startsWith('[Indexer] Watcher ignored:')
      );
      expect(ignoredLogs.length).toBe(5);

      vi.setSystemTime(new Date(baseTime.getTime() + 2001));
      ignored('src/ignored-6.js');

      const ignoredLogsAfter = infoSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].startsWith('[Indexer] Watcher ignored:')
      );
      expect(ignoredLogsAfter.length).toBe(6);

      vi.useRealTimers();
      infoSpy.mockRestore();
    });
  });
});
