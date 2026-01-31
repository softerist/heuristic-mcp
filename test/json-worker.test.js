import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('json-worker', () => {
  it('posts parsed JSON when read succeeds', async () => {
    const postMessage = vi.fn();
    const fsMock = {
      readFile: vi.fn().mockResolvedValue('{"ok": true}'),
    };

    vi.doMock('worker_threads', () => ({
      parentPort: { postMessage },
      workerData: { filePath: '/tmp/ok.json' },
    }));
    vi.doMock('fs/promises', () => ({
      default: fsMock,
      ...fsMock,
    }));

    await import('../lib/json-worker.js');
    await new Promise((resolve) => setImmediate(resolve));

    expect(postMessage).toHaveBeenCalledWith({ ok: true, data: { ok: true } });
  });

  it('posts errors when read fails', async () => {
    const postMessage = vi.fn();
    const fsMock = {
      readFile: vi.fn().mockRejectedValue(new Error('read failed')),
    };

    vi.doMock('worker_threads', () => ({
      parentPort: { postMessage },
      workerData: { filePath: '/tmp/bad.json' },
    }));
    vi.doMock('fs/promises', () => ({
      default: fsMock,
      ...fsMock,
    }));

    await import('../lib/json-worker.js');
    await new Promise((resolve) => setImmediate(resolve));

    expect(postMessage).toHaveBeenCalledWith({ ok: false, error: 'read failed' });
  });
});

