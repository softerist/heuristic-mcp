import { describe, it, expect, vi } from 'vitest';
import { CodebaseIndexer } from '../features/index-codebase.js';
import path from 'path';

// Helper to access the private/internal function if it was exported,
// but since it's not, we have to test it through public methods that use it.
// buildExcludeMatchers uses globToRegExp.
// isExcluded uses matchesExcludePatterns which uses buildExcludeMatchers.

describe('CodebaseIndexer Glob Coverage', () => {
  it('should handle single star glob patterns correctly', () => {
    // This targets the branch in globToRegExp:
    // if (char === "*") { ... } else { regex += "[^/]*"; ... }

    // We need a pattern with a single '*' that is NOT followed by '*'
    // e.g., "*.log" or "src/*.js"

    const config = {
      excludePatterns: ['*.log', 'src/*.js'],
      fileExtensions: ['js'],
      searchDirectory: '/test',
      verbose: true,
    };

    // Mock dependencies
    const embedder = vi.fn();
    const cache = { load: vi.fn() };

    const indexer = new CodebaseIndexer(embedder, cache, config);

    // These calls should trigger the regex generation and matching logic
    expect(indexer.isExcluded('error.log')).toBe(true);
    expect(indexer.isExcluded('src/utils.js')).toBe(true);
    expect(indexer.isExcluded('src/utils.test.js')).toBe(true);
    expect(indexer.isExcluded('src/sub/utils.js')).toBe(false); // Single * shouldn't match across dirs usually if it's not **
    expect(indexer.isExcluded('other.js')).toBe(false);
  });

  it('should handle question mark glob patterns', () => {
    // Targets: if (char === "?")

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
    // Targets: if (pattern[i + 1] === "*") ... else { regex += ".*"; ... }

    // Use a pattern with "/" to ensure matchBase is false, testing the full regex against path

    const config = {
      excludePatterns: ['dir/foo**bar'],

      fileExtensions: ['js'],

      searchDirectory: '/test',
    };

    const indexer = new CodebaseIndexer(vi.fn(), {}, config);

    // Pattern "dir/foo**bar" becomes "^dir/foo.*bar$"

    expect(indexer.isExcluded('dir/fooxyzbar')).toBe(true);

    expect(indexer.isExcluded('dir/foobar')).toBe(true);

    // ".*" matches "/" so this should match

    expect(indexer.isExcluded('dir/foo/nested/bar')).toBe(true);
  });
});

describe('CodebaseIndexer Worker Chunking', () => {
  it('should handle fewer chunks than workers (Line 222 coverage)', async () => {
    // config.workerThreads = 2

    // chunks = [1]

    // Worker 0 gets 1, Worker 1 gets 0 -> continues

    // Mock os.cpus() first

    vi.mock('os', async () => {
      const actual = await vi.importActual('os');

      return {
        ...actual,

        cpus: () => [{}, {}, {}, {}],
      };
    });

    // Mock worker_threads

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

    const config = { workerThreads: 2, verbose: true }; // Verbose to hit logging branches too

    const indexer = new CodebaseIndexer(
      vi.fn(),
      { save: vi.fn(), getVectorStore: () => [] },
      config
    );

    await indexer.initializeWorkers();

    // 1 chunk, 2 workers

    await indexer.processChunksWithWorkers([{ text: 'abc', file: 'f.js' }]);

    await indexer.terminateWorkers();

    vi.restoreAllMocks();
  });
});
