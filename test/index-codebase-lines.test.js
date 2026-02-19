import { describe, it, expect, vi } from 'vitest';
import { CodebaseIndexer } from '../features/index-codebase.js';
import path from 'path';






describe('CodebaseIndexer Glob Coverage', () => {
  it('should handle single star glob patterns correctly', () => {
    
    

    
    

    const config = {
      excludePatterns: ['*.log', 'src/*.js'],
      fileExtensions: ['js'],
      searchDirectory: '/test',
      verbose: true,
    };

    
    const embedder = vi.fn();
    const cache = { load: vi.fn() };

    const indexer = new CodebaseIndexer(embedder, cache, config);

    
    expect(indexer.isExcluded('error.log')).toBe(true);
    expect(indexer.isExcluded('src/utils.js')).toBe(true);
    expect(indexer.isExcluded('src/utils.test.js')).toBe(true);
    expect(indexer.isExcluded('src/sub/utils.js')).toBe(false); 
    expect(indexer.isExcluded('other.js')).toBe(false);
  });

  it('should handle question mark glob patterns', () => {
    

    const config = {
      excludePatterns: ['test?.js'],

      fileExtensions: ['js'],

      searchDirectory: '/test',
    };

    const indexer = new CodebaseIndexer(vi.fn(), {}, config);

    expect(indexer.isExcluded('test1.js')).toBe(true);

    expect(indexer.isExcluded('testA.js')).toBe(true);

    expect(indexer.isExcluded('test10.js')).toBe(false);
  });

  it('should handle double star not followed by slash', () => {
    

    

    const config = {
      excludePatterns: ['dir/foo**bar'],

      fileExtensions: ['js'],

      searchDirectory: '/test',
    };

    const indexer = new CodebaseIndexer(vi.fn(), {}, config);

    

    expect(indexer.isExcluded('dir/fooxyzbar')).toBe(true);

    expect(indexer.isExcluded('dir/foobar')).toBe(true);

    

    expect(indexer.isExcluded('dir/foo/nested/bar')).toBe(true);
  });
});

describe('CodebaseIndexer Worker Chunking', () => {
  it('should handle fewer chunks than workers (Line 222 coverage)', async () => {
    

    

    

    

    vi.mock('os', async () => {
      const actual = await vi.importActual('os');

      return {
        ...actual,

        cpus: () => [{}, {}, {}, {}],
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

    const { CodebaseIndexer } = await import('../features/index-codebase.js');

    const config = { workerThreads: 2, verbose: true }; 

    const indexer = new CodebaseIndexer(
      vi.fn(),
      { save: vi.fn(), getVectorStore: () => [] },
      config
    );

    await indexer.initializeWorkers();

    

    await indexer.processChunksWithWorkers([{ text: 'abc', file: 'f.js' }]);

    await indexer.terminateWorkers();

    vi.restoreAllMocks();
  });
});
