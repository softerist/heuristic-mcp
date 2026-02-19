import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const baseConfig = {
  enableCache: true,
  cacheDirectory: '/cache',
  embeddingModel: 'test-model',
  fileExtensions: ['js'],
  excludePatterns: [],
  annEnabled: false,
  callGraphEnabled: false,
  verbose: true,
};

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('EmbeddingsCache JSON worker parsing', () => {
  it('uses a worker to parse large JSON files', async () => {
    const Worker = vi.fn(function (_url, options) {
      const worker = new EventEmitter();
      const filePath = options.workerData.filePath;
      const data = filePath.endsWith('embeddings.json') ? [] : {};
      setImmediate(() => {
        worker.emit('message', { ok: true, data });
      });
      return worker;
    });

    const fsMock = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ size: 6 * 1024 * 1024 }),
      readFile: vi.fn((filePath) => {
        if (filePath.endsWith('meta.json')) {
          return Promise.resolve(
            JSON.stringify({ version: 1, embeddingModel: baseConfig.embeddingModel })
          );
        }
        return Promise.reject(new Error('missing'));
      }),
    };

    vi.doMock('worker_threads', () => ({ Worker }));
    vi.doMock('fs/promises', () => ({
      default: fsMock,
      ...fsMock,
    }));

    const { EmbeddingsCache } = await import('../lib/cache.js');
    const cache = new EmbeddingsCache(baseConfig);

    await cache.load();

    expect(Worker).toHaveBeenCalledTimes(2);
    expect(cache.getVectorStore()).toEqual([]);
  });

  it('logs when the JSON worker reports a parse error', async () => {
    const Worker = vi.fn(function () {
      const worker = new EventEmitter();
      setImmediate(() => {
        worker.emit('message', { ok: false, error: 'bad json' });
      });
      return worker;
    });

    const fsMock = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ size: 6 * 1024 * 1024 }),
      readFile: vi.fn((filePath) => {
        if (filePath.endsWith('meta.json')) {
          return Promise.resolve(
            JSON.stringify({ version: 1, embeddingModel: baseConfig.embeddingModel })
          );
        }
        return Promise.reject(new Error('missing'));
      }),
    };

    vi.doMock('worker_threads', () => ({ Worker }));
    vi.doMock('fs/promises', () => ({
      default: fsMock,
      ...fsMock,
    }));

    const { EmbeddingsCache } = await import('../lib/cache.js');
    const cache = new EmbeddingsCache(baseConfig);
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await cache.load();

    const hasParseError = consoleSpy.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('Failed to parse embeddings.json')
    );
    expect(hasParseError).toBe(true);

    consoleSpy.mockRestore();
  });

  it('logs when the JSON worker exits with a failure code', async () => {
    const Worker = vi.fn(function () {
      const worker = new EventEmitter();
      setImmediate(() => {
        worker.emit('exit', 1);
      });
      return worker;
    });

    const fsMock = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ size: 6 * 1024 * 1024 }),
      readFile: vi.fn((filePath) => {
        if (filePath.endsWith('meta.json')) {
          return Promise.resolve(
            JSON.stringify({ version: 1, embeddingModel: baseConfig.embeddingModel })
          );
        }
        return Promise.reject(new Error('missing'));
      }),
    };

    vi.doMock('worker_threads', () => ({ Worker }));
    vi.doMock('fs/promises', () => ({
      default: fsMock,
      ...fsMock,
    }));

    const { EmbeddingsCache } = await import('../lib/cache.js');
    const cache = new EmbeddingsCache(baseConfig);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await cache.load();

    const hasExitError = consoleSpy.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('JSON worker exited with code')
    );
    expect(hasExitError).toBe(true);

    consoleSpy.mockRestore();
  });

  it('ignores subsequent events after settlement (covers settled guard)', async () => {
    const Worker = vi.fn(function () {
      const worker = {
        once(event, handler) {
          if (event === 'message') {
            setImmediate(() => {
              handler({ ok: true, data: [] });
              handler({ ok: false, error: 'late' });
            });
          }
          return worker;
        },
        removeAllListeners: vi.fn(),
        terminate: vi.fn(() => Promise.resolve()),
      };
      return worker;
    });

    const fsMock = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ size: 6 * 1024 * 1024 }),
      readFile: vi.fn((filePath) => {
        if (filePath.endsWith('meta.json')) {
          return Promise.resolve(
            JSON.stringify({ version: 1, embeddingModel: baseConfig.embeddingModel })
          );
        }
        return Promise.reject(new Error('missing'));
      }),
    };

    vi.doMock('worker_threads', () => ({ Worker }));
    vi.doMock('fs/promises', () => ({
      default: fsMock,
      ...fsMock,
    }));

    const { EmbeddingsCache } = await import('../lib/cache.js');
    const cache = new EmbeddingsCache(baseConfig);

    await cache.load();

    expect(Worker).toHaveBeenCalled();
  });
});
