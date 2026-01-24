
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingsCache } from '../lib/cache.js';

// Hoist the mock worker
const { mockWorker } = vi.hoisted(() => {
    const worker = {
        on: vi.fn(),
        once: vi.fn(),
        removeAllListeners: vi.fn(),
        terminate: vi.fn(),
        postMessage: vi.fn(),
        unref: vi.fn()
    };
    return { mockWorker: worker };
});

// Use a shared variable to track execution
let terminateCatchCalled = false;

// Mock fs
vi.mock('fs/promises', async () => {
    return {
        default: {
            stat: vi.fn().mockResolvedValue({ 
                size: 6 * 1024 * 1024,
                isDirectory: () => false
            }),
            readFile: vi.fn().mockResolvedValue('[]'),
            mkdir: vi.fn().mockResolvedValue(),
            writeFile: vi.fn().mockResolvedValue(),
            rm: vi.fn().mockResolvedValue(),
        }
    }
});

// Mock worker_threads
vi.mock('worker_threads', () => {
    return {
        Worker: class {
            constructor() {
                return mockWorker;
            }
        }
    };
});

describe('Cache Worker Termination', () => {
    let cache;
    const config = {
        enableCache: true,
        cacheDirectory: '/test/cache',
        fileExtensions: ['js'],
        embeddingModel: 'test-model'
    };

    beforeEach(() => {
        vi.clearAllMocks();
        terminateCatchCalled = false;
        
        // Setup worker to simulate successful message
        mockWorker.once.mockImplementation((event, handler) => {
            if (event === 'message') {
                setTimeout(() => {
                    // cache.js expects ok: true
                    handler({ ok: true, data: [] });
                }, 10);
            }
        });
        
        mockWorker.on.mockImplementation((event, handler) => {
             if (event === 'message') {
                setTimeout(() => handler({ ok: true, data: [] }), 10);
            }
        });
        
        // Default terminate behavior
        mockWorker.terminate.mockResolvedValue(undefined);
        
        cache = new EmbeddingsCache(config);
    });

    it('should handle worker termination errors (line 29 coverage)', async () => {
        // Setup terminate to return an object with catch() that sets the flag
        // We use mockReturnValue to ensure it returns exactly this object
        const fakePromise = {
             catch: (cb) => { 
                 terminateCatchCalled = true; 
                 if (cb) cb();
                 return Promise.resolve();
             },
             then: (cb) => { if (cb) cb(); return Promise.resolve(); }
        };

        mockWorker.terminate.mockReturnValue(fakePromise);
        
        await cache.load();
        
        expect(mockWorker.terminate).toHaveBeenCalled();
        expect(terminateCatchCalled).toBe(true);
    });
});
