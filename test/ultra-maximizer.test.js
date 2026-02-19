import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodebaseIndexer, handleToolCall } from '../features/index-codebase.js';
import { EmbeddingsCache } from '../lib/cache.js';
import fs from 'fs/promises';
import path from 'path';

vi.mock('fs/promises');
vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('events');
  class Worker extends EventEmitter {
    constructor() {
      super();
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
        verbose: true,
      };
      const cache = new EmbeddingsCache(config);
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

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

      const { Worker } = await import('worker_threads');

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const terminateSpy = vi.spyOn(indexer, 'terminateWorkers');

      const initPromise = indexer.initializeWorkers();

      await new Promise((r) => setTimeout(r, 0));

      if (indexer.workers.length > 0) {
        indexer.workers[0].emit('message', { type: 'error', error: 'Init Fail' });
      }

      await initPromise;

      expect(terminateSpy).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Worker initialization failed')
      );
    });
  });
});
