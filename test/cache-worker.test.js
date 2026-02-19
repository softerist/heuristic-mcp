import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingsCache } from '../lib/cache.js';


const { mockWorker } = vi.hoisted(() => {
  const worker = {
    on: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
    terminate: vi.fn(),
    postMessage: vi.fn(),
    unref: vi.fn(),
  };
  return { mockWorker: worker };
});


let terminateCatchCalled = false;


vi.mock('fs/promises', async () => {
  return {
    default: {
      stat: vi.fn().mockResolvedValue({
        size: 6 * 1024 * 1024,
        isDirectory: () => false,
      }),
      readFile: vi.fn().mockResolvedValue('[]'),
      mkdir: vi.fn().mockResolvedValue(),
      writeFile: vi.fn().mockResolvedValue(),
      rm: vi.fn().mockResolvedValue(),
    },
  };
});


vi.mock('worker_threads', () => {
  return {
    Worker: class {
      constructor() {
        return mockWorker;
      }
    },
  };
});

describe('Cache Worker Termination', () => {
  let cache;
  const config = {
    enableCache: true,
    cacheDirectory: '/test/cache',
    fileExtensions: ['js'],
    embeddingModel: 'test-model',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    terminateCatchCalled = false;

    
    mockWorker.once.mockImplementation((event, handler) => {
      if (event === 'message') {
        setTimeout(() => {
          
          handler({ ok: true, data: [] });
        }, 10);
      }
    });

    mockWorker.on.mockImplementation((event, handler) => {
      if (event === 'message') {
        setTimeout(() => handler({ ok: true, data: [] }), 10);
      }
    });

    
    mockWorker.terminate.mockResolvedValue(undefined);

    cache = new EmbeddingsCache(config);
  });

  it('should handle worker termination errors (line 29 coverage)', async () => {
    
    
    const fakePromise = {
      catch: (cb) => {
        terminateCatchCalled = true;
        if (cb) cb();
        return Promise.resolve();
      },
      then: (cb) => {
        if (cb) cb();
        return Promise.resolve();
      },
    };

    mockWorker.terminate.mockReturnValue(fakePromise);

    await cache.load();

    expect(mockWorker.terminate).toHaveBeenCalled();
    expect(terminateCatchCalled).toBe(true);
  });
});
