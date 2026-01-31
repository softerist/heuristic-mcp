// Note: This test file cannot achieve 100% coverage because some code paths
// in register.js are specific to Windows, macOS, and Linux. The tests are
// running on a single platform, so the other platform-specific code is not
// executed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsPromisesMock = {};
const fsMock = {};

vi.mock('fs/promises', () => ({ default: fsPromisesMock }));
vi.mock('fs', () => fsMock);

const setPlatform = (value) => {
  Object.defineProperty(process, 'platform', { value, configurable: true });
};

describe('register', () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;
  let consoleError;

  beforeEach(() => {
    fsPromisesMock.access = vi.fn();
    fsPromisesMock.mkdir = vi.fn();
    fsPromisesMock.readFile = vi.fn();
    fsPromisesMock.writeFileSync = vi.fn();
    fsMock.writeFileSync = vi.fn();
    fsMock.existsSync = vi.fn();
    fsMock.statSync = vi.fn();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    setPlatform(originalPlatform);
    consoleError.mockRestore();
    vi.resetModules();
  });

  it('creates a config when Antigravity is detected', async () => {
    process.env.ANTIGRAVITY_AGENT = '1';
    setPlatform('win32');
    fsPromisesMock.access.mockRejectedValue(new Error('missing'));
    fsPromisesMock.mkdir.mockResolvedValue();

    const { register } = await import('../features/register.js');

    await register();

    expect(fsPromisesMock.mkdir).toHaveBeenCalled();
    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });

  it('prints manual config when no IDE configs are writable', async () => {
    delete process.env.ANTIGRAVITY_AGENT;
    delete process.env.CURSOR_AGENT;
    setPlatform('win32');
    fsMock.existsSync.mockReturnValue(false);
    fsMock.statSync.mockImplementation(() => {
      throw new Error('missing');
    });
    fsPromisesMock.access.mockRejectedValue(new Error('missing'));

    const { register } = await import('../features/register.js');

    await register();

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Manual Config'));
  });

  it('detects Antigravity via fallback directory check', async () => {
    delete process.env.ANTIGRAVITY_AGENT;
    delete process.env.CURSOR_AGENT;
    setPlatform('linux');
    fsMock.existsSync.mockReturnValue(true);
    fsMock.statSync.mockReturnValue({ isDirectory: () => true });
    fsPromisesMock.access.mockRejectedValue(new Error('missing'));
    fsPromisesMock.mkdir.mockResolvedValue();

    const { register } = await import('../features/register.js');

    await register();

    expect(fsPromisesMock.mkdir).toHaveBeenCalled();
    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });

  it('uses darwin config paths for Claude Desktop and Cursor', async () => {
    process.env.ANTIGRAVITY_AGENT = '1';
    setPlatform('darwin');
    fsPromisesMock.access.mockRejectedValue(new Error('missing'));
    fsPromisesMock.mkdir.mockResolvedValue();

    const { register } = await import('../features/register.js');

    await register();

    expect(fsPromisesMock.mkdir).toHaveBeenCalled();
    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });

  it('handles corrupt config files gracefully', async () => {
    delete process.env.ANTIGRAVITY_AGENT;
    process.env.CURSOR_AGENT = '1';
    setPlatform('win32');
    fsPromisesMock.access.mockResolvedValue();
    fsPromisesMock.readFile.mockResolvedValue('{not-json');

    const { register } = await import('../features/register.js');

    await register();

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Warning'));
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('handles empty config files as new', async () => {
    delete process.env.ANTIGRAVITY_AGENT;
    process.env.CURSOR_AGENT = '1';
    setPlatform('win32');
    fsPromisesMock.access.mockResolvedValue();
    fsPromisesMock.readFile.mockResolvedValue('   ');

    const { register } = await import('../features/register.js');

    await register();

    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });

  it('skips non-matching IDEs when filter is provided', async () => {
    process.env.ANTIGRAVITY_AGENT = '1';
    setPlatform('win32');
    fsPromisesMock.access.mockRejectedValue(new Error('missing'));
    fsPromisesMock.mkdir.mockResolvedValue();

    const { register } = await import('../features/register.js');

    await register('cursor');

    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('logs when config directory cannot be created', async () => {
    process.env.ANTIGRAVITY_AGENT = '1';
    setPlatform('win32');
    fsPromisesMock.access.mockRejectedValue(new Error('missing'));
    fsPromisesMock.mkdir.mockRejectedValue(new Error('nope'));

    const { register } = await import('../features/register.js');

    await register();

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Cannot create config directory')
    );
  });

  it('logs registration failures when writing config fails', async () => {
    process.env.ANTIGRAVITY_AGENT = '1';
    setPlatform('win32');
    fsPromisesMock.access.mockResolvedValue();
    fsPromisesMock.readFile.mockResolvedValue('{}');
    fsMock.writeFileSync.mockImplementation(() => {
      throw new Error('write failed');
    });

    const { register } = await import('../features/register.js');

    await register();

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Failed to register'));
  });

  it('registers config on non-win32 platforms', async () => {
    process.env.ANTIGRAVITY_AGENT = '1';
    setPlatform('linux');
    fsPromisesMock.access.mockRejectedValue(new Error('missing'));
    fsPromisesMock.mkdir.mockResolvedValue();

    const { register } = await import('../features/register.js');

    await register();

    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });

  it('falls back to console.error when tty logging fails', async () => {
    process.env.ANTIGRAVITY_AGENT = '1';
    setPlatform('linux');
    fsPromisesMock.access.mockRejectedValue(new Error('missing'));
    fsPromisesMock.mkdir.mockResolvedValue();
    fsMock.writeFileSync.mockImplementation((targetPath) => {
      if (targetPath === '/dev/tty') {
        throw new Error('tty denied');
      }
    });

    const { register } = await import('../features/register.js');

    await register();

    expect(consoleError).toHaveBeenCalled();
  });

  it('handles missing APPDATA on Windows', async () => {
    process.env.ANTIGRAVITY_AGENT = '1';
    setPlatform('win32');
    delete process.env.APPDATA;
    fsPromisesMock.access.mockRejectedValue(new Error('missing'));
    fsPromisesMock.mkdir.mockResolvedValue();

    const { register } = await import('../features/register.js');
    await register();

    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });

  it('handles missing INIT_CWD for Antigravity', async () => {
    process.env.ANTIGRAVITY_AGENT = '1';
    setPlatform('win32');
    delete process.env.INIT_CWD;
    fsPromisesMock.access.mockResolvedValue();
    fsPromisesMock.readFile.mockResolvedValue('{}');

    const { register } = await import('../features/register.js');
    await register();

    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });

  it('handles existing mcpServers object', async () => {
    delete process.env.ANTIGRAVITY_AGENT;
    process.env.CURSOR_AGENT = '1';
    setPlatform('win32');
    fsPromisesMock.access.mockResolvedValue();
    fsPromisesMock.readFile.mockResolvedValue(JSON.stringify({ mcpServers: { other: {} } }));

    const { register } = await import('../features/register.js');
    await register();

    const written = JSON.parse(fsMock.writeFileSync.mock.calls[0][1]);
    expect(written.mcpServers.other).toBeDefined();
    expect(written.mcpServers['heuristic-mcp']).toBeDefined();
  });

  it('handles missing LOCALAPPDATA on Windows', async () => {
    // This targets line 205
    process.env.ANTIGRAVITY_AGENT = '1';
    setPlatform('win32');
    delete process.env.LOCALAPPDATA;
    // Ensure registerCount > 0 to hit the block
    fsPromisesMock.access.mockResolvedValue();
    fsPromisesMock.readFile.mockResolvedValue('{}');

    const { register } = await import('../features/register.js');
    await register();

    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });
});

