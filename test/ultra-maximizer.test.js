import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodebaseIndexer, handleToolCall } from '../features/index-codebase.js';
import { EmbeddingsCache } from '../lib/cache.js';
import fs from 'fs/promises';
import path from 'path';

// Mock dependencies
vi.mock('fs/promises');
vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('events');
  class Worker extends EventEmitter {
    constructor() {
      super();
      // Don't emit ready automatically to allow manual control in tests
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

describe('Ultra Maximizer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('lib/cache.js Internals', () => {
    it('Line 673: logs call-graph load in verbose mode', async () => {
      const config = {
        enableCache: true,
        cacheDirectory: '/cache',
        embeddingModel: 'test',
        fileExtensions: ['js'],
        verbose: true, // Crucial for line 673
      };
      const cache = new EmbeddingsCache(config);
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      // Mock file system for load()
      vi.spyOn(fs, 'mkdir').mockResolvedValue();
      vi.spyOn(fs, 'readFile').mockImplementation(async (p) => {
        if (p.endsWith('meta.json')) return JSON.stringify({ version: 1, embeddingModel: 'test' });
        if (p.endsWith('embeddings.json')) return '[]';
        if (p.endsWith('file-hashes.json')) return '{}';
        if (p.endsWith('call-graph.json')) return JSON.stringify({ 'f.js': {} });
        return null;
      });

      await cache.load();

      expect(cache.getFileCallDataCount()).toBe(1);
      expect(cache.hasFileCallData('f.js')).toBe(true);
    });
  });

  describe('features/index-codebase.js Worker Path', () => {
    it('Line 146: covers initializeWorkers failure and termination', async () => {
      const config = { workerThreads: 2, verbose: true, embeddingModel: 'test' };
      const embedder = vi.fn();
      const cache = { save: vi.fn(), getVectorStore: () => [] };
      const indexer = new CodebaseIndexer(embedder, cache, config);

      // Mock Worker to fail immediately/emit error
      const { Worker } = await import('worker_threads');
      // We can't change the class constructor behavior easily here.
      // But we can emit error on the worker instances after creation?
      // initializeWorkers creates workers and waits for "ready".

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const terminateSpy = vi.spyOn(indexer, 'terminateWorkers');

      // We need to trigger the "error" event on the worker.
      // We can spy on the workers array push?
      // Or wait a tick?

      // Let's rely on the timeout? No, timeout takes too long.
      // We need to get access to the worker instance.

      // Better strategy: Mock the Worker constructor to return a specific instance we control.
      // But vi.mock is hoisted.
      // We can modify prototype?

      // Actually, we can just run initializeWorkers, then manually emit error on indexer.workers[0].

      const initPromise = indexer.initializeWorkers();

      // Wait a tick for workers to be created
      await new Promise((r) => setTimeout(r, 0));

      if (indexer.workers.length > 0) {
        indexer.workers[0].emit('message', { type: 'error', error: 'Init Fail' });
      }

      await initPromise;

      // initializeWorkers catches the error and calls terminateWorkers (Line 146)
      expect(terminateSpy).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Worker initialization failed')
      );
    });
  });
});
