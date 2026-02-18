import { describe, expect, it } from 'vitest';
import { normalizeCliArgs, parseArgs, shouldDefaultToHelp } from '../lib/cli.js';

describe('CLI aliases', () => {
  it('maps positional status command to --status', () => {
    const parsed = parseArgs(['node', 'index.js', 'status']);
    expect(parsed.wantsStatus).toBe(true);
    expect(parsed.isServerMode).toBe(false);
    expect(parsed.unknownFlags).toEqual([]);
  });

  it('maps log command and --log alias to --logs', () => {
    expect(normalizeCliArgs(['log'])).toEqual(['--logs']);
    expect(normalizeCliArgs(['--log', '--tail', '20'])).toEqual(['--logs', '--tail', '20']);

    const parsed = parseArgs(['node', 'index.js', '--log', '--tail', '20']);
    expect(parsed.wantsLogs).toBe(true);
    expect(parsed.tailLines).toBe(20);
  });

  it('maps start command and preserves its value argument', () => {
    expect(normalizeCliArgs(['start', 'antigravity'])).toEqual(['--start', 'antigravity']);
    expect(normalizeCliArgs(['start', 'status'])).toEqual(['--start', 'status']);

    const parsed = parseArgs(['node', 'index.js', 'start', 'antigravity']);
    expect(parsed.wantsStart).toBe(true);
    expect(parsed.startFilter).toBe('antigravity');
  });

  it('maps cache and clear-cache commands', () => {
    const cacheParsed = parseArgs(['node', 'index.js', 'cache', '--clean']);
    expect(cacheParsed.wantsCache).toBe(true);
    expect(cacheParsed.wantsClean).toBe(true);

    const clearParsed = parseArgs(['node', 'index.js', 'clear-cache']);
    expect(clearParsed.wantsClearCache).toBe(true);
  });

  it('maps mem, version, help aliases', () => {
    expect(parseArgs(['node', 'index.js', 'mem']).wantsMem).toBe(true);
    expect(parseArgs(['node', 'index.js', 'version']).wantsVersion).toBe(true);
    expect(parseArgs(['node', 'index.js', 'help']).wantsHelp).toBe(true);
  });

  it('defaults to help on no args in interactive terminal only', () => {
    expect(shouldDefaultToHelp([], { stdinIsTTY: true, stdoutIsTTY: true })).toBe(true);
    expect(shouldDefaultToHelp([], { stdinIsTTY: false, stdoutIsTTY: false })).toBe(false);

    const interactive = parseArgs(['node', 'index.js'], { stdinIsTTY: true, stdoutIsTTY: true });
    expect(interactive.wantsHelp).toBe(true);
    expect(interactive.isServerMode).toBe(false);

    const nonInteractive = parseArgs(['node', 'index.js'], {
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });
    expect(nonInteractive.wantsHelp).toBe(false);
    expect(nonInteractive.isServerMode).toBe(true);
  });
});
