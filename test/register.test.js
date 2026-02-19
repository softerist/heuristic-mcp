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
    delete process.env.CODEX_THREAD_ID;
    setPlatform('win32');
    fsPromisesMock.access.mockRejectedValue(new Error('missing'));
    fsPromisesMock.mkdir.mockRejectedValue(new Error('no perms'));

    const { register } = await import('../features/register.js');

    await register();

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Manual Config'));
  });

  it('detects Codex via environment variable', async () => {
    delete process.env.ANTIGRAVITY_AGENT;
    delete process.env.CURSOR_AGENT;
    process.env.CODEX_THREAD_ID = 'abc123';
    setPlatform('linux');
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

    await register('cursor');

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

  it('registers Antigravity with dynamic workspace args', async () => {
    process.env.ANTIGRAVITY_AGENT = '1';
    setPlatform('win32');
    fsPromisesMock.access.mockResolvedValue();
    fsPromisesMock.readFile.mockResolvedValue('{}');

    const { register } = await import('../features/register.js');
    await register();

    const [, writtenText] = fsMock.writeFileSync.mock.calls[0];
    const parsed = JSON.parse(writtenText);
    expect(parsed.mcpServers['heuristic-mcp'].command).toBe('heuristic-mcp');
    expect(parsed.mcpServers['heuristic-mcp'].args).toEqual([
      '--workspace',
      '${workspaceFolder}',
      '--workspace',
      '${workspaceRoot}',
      '--workspace',
      '${workspace}',
    ]);
    expect(parsed.mcpServers['heuristic-mcp'].env).toEqual({
      HEURISTIC_MCP_ENABLE_DYNAMIC_WORKSPACE_ENV: 'true',
    });
    expect(parsed.mcpServers['heuristic-mcp']).not.toHaveProperty('disabled');
  });

  it('does not write disabled = false in Codex TOML config', async () => {
    delete process.env.ANTIGRAVITY_AGENT;
    delete process.env.CURSOR_AGENT;
    process.env.CODEX_THREAD_ID = 'abc123';
    setPlatform('win32');
    fsPromisesMock.access.mockResolvedValue();
    fsPromisesMock.readFile.mockResolvedValue('');

    const { register } = await import('../features/register.js');
    await register('codex');

    const codexCall = fsMock.writeFileSync.mock.calls.find(([filePath]) =>
      String(filePath).toLowerCase().endsWith('\\.codex\\config.toml')
    );
    expect(codexCall).toBeDefined();
    expect(String(codexCall[1])).toContain('[mcp_servers.heuristic-mcp]');
    expect(String(codexCall[1])).toContain('command = "heuristic-mcp"');
    expect(String(codexCall[1])).toContain(
      'args = ["--workspace", "${workspaceFolder}", "--workspace", "${workspaceRoot}", "--workspace", "${workspace}"]'
    );
    expect(String(codexCall[1])).not.toContain('disabled = false');
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
    process.env.ANTIGRAVITY_AGENT = '1';
    setPlatform('win32');
    delete process.env.LOCALAPPDATA;

    fsPromisesMock.access.mockResolvedValue();
    fsPromisesMock.readFile.mockResolvedValue('{}');

    const { register } = await import('../features/register.js');
    await register();

    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });

  it('registers VS Code mcp.json entries under servers when filtered', async () => {
    delete process.env.ANTIGRAVITY_AGENT;
    delete process.env.CURSOR_AGENT;
    delete process.env.CODEX_THREAD_ID;
    setPlatform('win32');
    fsPromisesMock.access.mockResolvedValue();
    fsPromisesMock.readFile.mockResolvedValue('{}');

    const { register } = await import('../features/register.js');
    await register('vscode');

    expect(fsMock.writeFileSync).toHaveBeenCalled();
    const matchingCall = fsMock.writeFileSync.mock.calls.find(([filePath]) =>
      String(filePath).toLowerCase().includes('\\code\\user\\mcp.json')
    );
    expect(matchingCall).toBeDefined();
    const parsed = JSON.parse(matchingCall[1]);
    expect(parsed.servers).toBeDefined();
    expect(parsed.servers['heuristic-mcp']).toBeDefined();
  });

  it('includes Cursor global mcp config when filtered by cursor', async () => {
    delete process.env.ANTIGRAVITY_AGENT;
    delete process.env.CURSOR_AGENT;
    setPlatform('win32');
    fsPromisesMock.access.mockResolvedValue();
    fsPromisesMock.readFile.mockResolvedValue('{}');

    const { register } = await import('../features/register.js');
    await register('cursor');

    const cursorGlobalCall = fsMock.writeFileSync.mock.calls.find(
      ([filePath]) =>
        String(filePath).toLowerCase().includes('.cursor') &&
        String(filePath).toLowerCase().endsWith('mcp.json')
    );
    expect(cursorGlobalCall).toBeDefined();
  });

  it('updates windsurf global mcp config when filtered by windsurf', async () => {
    delete process.env.ANTIGRAVITY_AGENT;
    delete process.env.CURSOR_AGENT;
    setPlatform('win32');
    fsPromisesMock.access.mockResolvedValue();
    fsPromisesMock.readFile.mockResolvedValue('{}');

    const { register } = await import('../features/register.js');
    await register('windsurf');

    const windsurfCall = fsMock.writeFileSync.mock.calls.find(
      ([filePath]) =>
        String(filePath).toLowerCase().includes('.codeium') &&
        String(filePath).toLowerCase().includes('windsurf') &&
        String(filePath).toLowerCase().endsWith('mcp_config.json')
    );
    expect(windsurfCall).toBeDefined();
  });

  it('updates warp mcp config when filtered by warp', async () => {
    delete process.env.ANTIGRAVITY_AGENT;
    delete process.env.CURSOR_AGENT;
    delete process.env.CODEX_THREAD_ID;
    setPlatform('win32');
    fsPromisesMock.access.mockResolvedValue();
    fsPromisesMock.readFile.mockResolvedValue('{}');

    const { register } = await import('../features/register.js');
    await register('warp');

    const warpCall = fsMock.writeFileSync.mock.calls.find(
      ([filePath]) =>
        String(filePath).toLowerCase().includes('.warp') &&
        String(filePath).toLowerCase().endsWith('mcp_settings.json')
    );
    expect(warpCall).toBeDefined();
  });
});
