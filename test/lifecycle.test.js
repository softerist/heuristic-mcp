import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let execPromiseMock;
const fsMock = {};
const osMock = {};
let registerMock;

vi.mock('child_process', () => ({ exec: vi.fn() }));
vi.mock('util', () => ({
  default: { promisify: () => execPromiseMock },
  promisify: () => execPromiseMock,
}));
vi.mock('fs/promises', () => ({ default: fsMock }));
vi.mock('os', () => ({ default: osMock }));
vi.mock('../features/register.js', () => ({
  register: (...args) => registerMock(...args),
}));

const setPlatform = (value) => {
  Object.defineProperty(process, 'platform', { value, configurable: true });
};

describe('lifecycle', () => {
  const originalPlatform = process.platform;
  const originalPid = process.pid;
  let consoleLog;
  let consoleWarn;
  let consoleError;
  let killSpy;

  beforeEach(() => {
    execPromiseMock = vi.fn();
    fsMock.readFile = vi.fn();
    fsMock.unlink = vi.fn().mockResolvedValue();
    fsMock.readdir = vi.fn();
    fsMock.stat = vi.fn();
    fsMock.access = vi.fn();
    osMock.homedir = () => 'C:/Users/test';
    registerMock = vi.fn();
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
    consoleError.mockRestore();
    killSpy.mockRestore();
    vi.resetModules();
  });

  it('stops cleanly when no win32 processes are found', async () => {
    setPlatform('win32');
    execPromiseMock.mockResolvedValue({ stdout: '' });
    const { stop } = await import('../features/lifecycle.js');

    await stop();

    expect(consoleLog).toHaveBeenCalledWith(
      '[Lifecycle] No running instances found (already stopped).'
    );
  });

  it('stops win32 processes and warns on kill failures', async () => {
    setPlatform('win32');
    execPromiseMock.mockResolvedValue({
      stdout: `${originalPid}\n1234\n5678\n`,
    });
    killSpy.mockImplementation((pid, signal) => {
      if (pid === 5678) {
        const err = new Error('Denied');
        err.code = 'EPERM';
        throw err;
      }
      return true;
    });
    const { stop } = await import('../features/lifecycle.js');

    await stop();

    expect(consoleWarn).toHaveBeenCalled();
  });

  it('handles pgrep exit code 1 on non-win32', async () => {
    setPlatform('linux');
    execPromiseMock.mockRejectedValue({ code: 1 });
    const { stop } = await import('../features/lifecycle.js');

    await stop();

    expect(consoleLog).toHaveBeenCalledWith(
      '[Lifecycle] No running instances found (already stopped).'
    );
  });

  it('stops non-win32 processes discovered via pgrep', async () => {
    setPlatform('linux');
    execPromiseMock.mockResolvedValue({ stdout: '1234 5678' });
    const { stop } = await import('../features/lifecycle.js');

    await stop();

    expect(killSpy).toHaveBeenCalledWith(1234, 0);
    expect(killSpy).toHaveBeenCalledWith(5678, 0);
    expect(killSpy).toHaveBeenCalledWith(1234, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(5678, 'SIGTERM');
  });

  it('warns when non-win32 stop fails to kill a PID', async () => {
    setPlatform('linux');
    execPromiseMock.mockResolvedValue({ stdout: '1234' });
    killSpy.mockImplementation((pid, signal) => {
      if (signal === 'SIGTERM') {
        const err = new Error('Denied');
        err.code = 'EPERM';
        throw err;
      }
      return true;
    });
    const { stop } = await import('../features/lifecycle.js');

    await stop();

    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('Failed to kill PID 1234'));
  });

  it('warns on unexpected pgrep errors', async () => {
    setPlatform('linux');
    execPromiseMock.mockRejectedValue({ code: 2, message: 'boom' });
    const { stop } = await import('../features/lifecycle.js');

    await stop();

    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('Stop command encountered an error')
    );
  });

  it('skips current pid when stopping non-win32 processes', async () => {
    setPlatform('linux');
    execPromiseMock.mockResolvedValue({ stdout: `${originalPid} 1234` });
    const { stop } = await import('../features/lifecycle.js');

    await stop();

    expect(killSpy).not.toHaveBeenCalledWith(originalPid, 0);
    expect(killSpy).toHaveBeenCalledWith(1234, 0);
  });

  it('starts and reports register errors', async () => {
    registerMock.mockRejectedValue(new Error('boom'));
    const { start } = await import('../features/lifecycle.js');

    await start();

    expect(consoleError).toHaveBeenCalled();
  });

  it('starts and logs success output', async () => {
    registerMock.mockResolvedValue();
    const { start } = await import('../features/lifecycle.js');

    await start();

    expect(consoleLog).toHaveBeenCalledWith('[Lifecycle] ✅ Configuration checked.');
    expect(consoleLog).toHaveBeenCalledWith(
      '[Lifecycle] To start the server, please reload your IDE window or restart the IDE.'
    );
  });

  it('reports status with cache details on non-win32', async () => {
    setPlatform('linux');
    fsMock.readFile.mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('.heuristic-mcp.pid')) {
        return '2222';
      }
      if (String(filePath).endsWith('meta.json')) {
        return JSON.stringify({
          workspace: 'repo',
          filesIndexed: 2,
          chunksStored: 3,
          lastSaveTime: new Date().toISOString(),
        });
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    fsMock.readdir.mockResolvedValue(['cacheA', 'cacheB']);
    fsMock.stat.mockResolvedValue({
      mtime: new Date(Date.now() - 11 * 60 * 1000),
    });
    fsMock.access.mockRejectedValue(new Error('nope'));
    execPromiseMock.mockImplementation(async (cmd) => {
      if (cmd === 'ps aux') {
        return { stdout: 'user 3333 0.0 0.1 heuristic-mcp/index.js' };
      }
      if (cmd === 'npm config get prefix') {
        return { stdout: '/usr/local' };
      }
      return { stdout: '' };
    });
    killSpy.mockImplementation(() => {
      const err = new Error('stale');
      err.code = 'ESRCH';
      throw err;
    });
    const { status } = await import('../features/lifecycle.js');

    await status();

    expect(consoleError).not.toHaveBeenCalled();
    expect(fsMock.readdir).toHaveBeenCalled();
    expect(fsMock.unlink).toHaveBeenCalled();
  });

  it('skips invalid PID file entries', async () => {
    setPlatform('linux');
    fsMock.readFile.mockResolvedValue('not-a-number');
    fsMock.readdir.mockResolvedValue([]);
    fsMock.access.mockRejectedValue(new Error('missing'));
    execPromiseMock.mockImplementation(async (cmd) => {
      if (cmd === 'ps aux') {
        return { stdout: '' };
      }
      if (cmd === 'npm config get prefix') {
        return { stdout: '/usr/local' };
      }
      return { stdout: '' };
    });
    const { status } = await import('../features/lifecycle.js');

    await status();

    expect(consoleLog).toHaveBeenCalledWith('[Lifecycle] ⚪ Server is STOPPED.');
  });

  it('reports running status when PID file points to live process', async () => {
    setPlatform('linux');
    fsMock.readFile.mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('.heuristic-mcp.pid')) {
        return '4444';
      }
      if (String(filePath).endsWith('meta.json')) {
        return JSON.stringify({ filesIndexed: 1, chunksStored: 1 });
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    fsMock.readdir.mockResolvedValue(['cacheOnly']);
    fsMock.access.mockRejectedValue(new Error('missing'));
    execPromiseMock.mockImplementation(async (cmd) => {
      if (cmd === 'npm config get prefix') {
        return { stdout: '/usr/local' };
      }
      return { stdout: '' };
    });
    killSpy.mockReturnValue(true);
    const { status } = await import('../features/lifecycle.js');

    await status();

    expect(killSpy).toHaveBeenCalledWith(4444, 0);
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Server is RUNNING'));
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('cache directory'));
  });

  it('reports stopped status and empty cache dirs on win32', async () => {
    setPlatform('win32');
    process.env.LOCALAPPDATA = 'C:/LocalApp';
    process.env.APPDATA = 'C:/Roaming';
    fsMock.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    fsMock.readdir.mockResolvedValue([]);
    fsMock.access.mockRejectedValue(new Error('missing'));
    const { status } = await import('../features/lifecycle.js');

    await status();

    expect(consoleLog).toHaveBeenCalledWith('[Lifecycle] ⚪ Server is STOPPED.');
    expect(consoleLog).toHaveBeenCalledWith('[Status] No cache directories found.');
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Expected location: C:\\LocalApp\\heuristic-mcp')
    );
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Cursor\\User\\settings.json'));
  });

  it('uses win32 cache root fallback when LOCALAPPDATA is unset', async () => {
    setPlatform('win32');
    delete process.env.LOCALAPPDATA;
    process.env.APPDATA = 'C:/Roaming';
    fsMock.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    fsMock.readdir.mockResolvedValue([]);
    fsMock.access.mockRejectedValue(new Error('missing'));
    const { status } = await import('../features/lifecycle.js');

    await status();

    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Expected location:'));
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('AppData\\Local\\heuristic-mcp')
    );
  });

  it('uses win32 Cursor config path fallback when APPDATA is unset', async () => {
    setPlatform('win32');
    delete process.env.APPDATA;
    fsMock.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    fsMock.readdir.mockResolvedValue([]);
    fsMock.access.mockRejectedValue(new Error('missing'));
    const { status } = await import('../features/lifecycle.js');

    await status();

    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Cursor\\User\\settings.json'));
  });

  it('reports indexing status for empty and incomplete caches on darwin', async () => {
    setPlatform('darwin');
    fsMock.readFile.mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('.heuristic-mcp.pid')) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      if (String(filePath).includes('cacheA') && String(filePath).endsWith('meta.json')) {
        return JSON.stringify({ filesIndexed: 0, chunksStored: 0 });
      }
      if (String(filePath).includes('cacheB') && String(filePath).endsWith('meta.json')) {
        return JSON.stringify({ workspace: 'repo' });
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    fsMock.readdir.mockResolvedValue(['cacheA', 'cacheB']);
    fsMock.access.mockRejectedValue(new Error('missing'));
    execPromiseMock.mockResolvedValue({ stdout: '' });
    const { status } = await import('../features/lifecycle.js');

    await status();

    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Indexing: ⚠️  NO FILES'));
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Indexing: ⚠️  INCOMPLETE'));
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Library\\Application Support\\Cursor\\User\\settings.json')
    );
  });

  it('merges valid PIDs from process list when no PID file exists', async () => {
    setPlatform('linux');
    fsMock.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    fsMock.readdir.mockResolvedValue([]);
    fsMock.access.mockRejectedValue(new Error('missing'));
    execPromiseMock.mockImplementation(async (cmd) => {
      if (cmd === 'ps aux') {
        return { stdout: 'user 5555 0.0 0.1 heuristic-mcp/index.js' };
      }
      if (cmd === 'npm config get prefix') {
        return { stdout: '/usr/local' };
      }
      return { stdout: '' };
    });
    const { status } = await import('../features/lifecycle.js');

    await status();

    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Server is RUNNING. PID(s): 5555')
    );
  });

  it('skips grep lines and duplicate PIDs in process list', async () => {
    setPlatform('linux');
    fsMock.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    fsMock.readdir.mockResolvedValue([]);
    fsMock.access.mockRejectedValue(new Error('missing'));
    execPromiseMock.mockImplementation(async (cmd) => {
      if (cmd === 'ps aux') {
        return {
          stdout: [
            'user 6666 0.0 0.1 heuristic-mcp/index.js',
            'user 6666 0.0 0.1 heuristic-mcp/index.js',
            'user 7777 0.0 0.1 heuristic-mcp/index.js grep heuristic-mcp',
          ].join('\n'),
        };
      }
      if (cmd === 'npm config get prefix') {
        return { stdout: '/usr/local' };
      }
      return { stdout: '' };
    });
    const { status } = await import('../features/lifecycle.js');

    await status();

    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('PID(s): 6666'));
    expect(consoleLog).not.toHaveBeenCalledWith(expect.stringContaining('7777'));
  });

  it('handles missing meta files and corrupted caches', async () => {
    setPlatform('linux');
    fsMock.readFile.mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('.heuristic-mcp.pid')) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      if (String(filePath).includes('corruptCache') && String(filePath).endsWith('meta.json')) {
        const err = new Error('denied');
        err.code = 'EACCES';
        throw err;
      }
      const err = new Error('missing');
      err.code = 'ENOENT';
      throw err;
    });
    fsMock.readdir.mockResolvedValue(['newCache', 'oldCache', 'badCache', 'corruptCache']);
    fsMock.stat.mockImplementation(async (cacheDir) => {
      if (String(cacheDir).includes('newCache')) {
        return { mtime: new Date() };
      }
      if (String(cacheDir).includes('oldCache')) {
        return { mtime: new Date(Date.now() - 11 * 60 * 1000) };
      }
      throw new Error('stat failed');
    });
    fsMock.access.mockRejectedValue(new Error('missing'));
    execPromiseMock.mockResolvedValue({ stdout: '' });
    const { status } = await import('../features/lifecycle.js');

    await status();

    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Initializing / Indexing in progress')
    );
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Incomplete cache (stale)'));
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Invalid cache directory'));
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Invalid or corrupted'));
  });

  it('reports fatal status errors', async () => {
    osMock.homedir = () => {
      throw new Error('boom');
    };
    const { status } = await import('../features/lifecycle.js');

    await status();

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Failed to check status'));
  });

  it('reports empty cache dirs when readdir fails', async () => {
    setPlatform('linux');
    fsMock.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    fsMock.readdir.mockRejectedValue(new Error('bad read'));
    fsMock.access.mockRejectedValue(new Error('missing'));
    execPromiseMock.mockImplementation(async (cmd) => {
      if (cmd === 'ps aux') {
        return { stdout: '' };
      }
      if (cmd === 'npm config get prefix') {
        return { stdout: '/usr/local' };
      }
      return { stdout: '' };
    });
    const { status } = await import('../features/lifecycle.js');

    await status();

    expect(consoleLog).toHaveBeenCalledWith('[Status] No cache directories found.');
  });

  it('marks config paths as existing when access succeeds', async () => {
    setPlatform('linux');
    fsMock.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    fsMock.readdir.mockResolvedValue([]);
    fsMock.access.mockResolvedValue();
    execPromiseMock.mockImplementation(async (cmd) => {
      if (cmd === 'ps aux') {
        return { stdout: '' };
      }
      if (cmd === 'npm config get prefix') {
        return { stdout: '/usr/local' };
      }
      return { stdout: '' };
    });
    const { status } = await import('../features/lifecycle.js');

    await status();

    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('(exists)'));
  });

  it('handles ESRCH error when killing a process', async () => {
    setPlatform('win32');
    execPromiseMock.mockResolvedValue({ stdout: '1234\n' });
    killSpy.mockImplementation(() => {
      const err = new Error('Already dead');
      err.code = 'ESRCH';
      throw err;
    });
    const { stop } = await import('../features/lifecycle.js');

    await stop();

    expect(killSpy).toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalledWith(expect.stringContaining('Failed to kill PID'));
  });

  it('handles error when unlinking stale PID file', async () => {
    setPlatform('linux');
    fsMock.readFile.mockResolvedValue('9999');
    killSpy.mockImplementation(() => {
      throw new Error('dead');
    });
    fsMock.unlink.mockRejectedValue(new Error('unlink failed'));
    fsMock.readdir.mockResolvedValue([]);
    fsMock.access.mockRejectedValue(new Error('missing'));
    execPromiseMock.mockResolvedValue({ stdout: '' });
    const { status } = await import('../features/lifecycle.js');

    await status();

    expect(fsMock.unlink).toHaveBeenCalledWith(expect.stringContaining('.heuristic-mcp.pid'));
    expect(consoleError).not.toHaveBeenCalled();
  });
});
