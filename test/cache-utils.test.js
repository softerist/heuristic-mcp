import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Mock getGlobalCacheDir before importing clearStaleCaches
let testCacheRoot;
vi.mock('../lib/config.js', () => ({
  getGlobalCacheDir: () => testCacheRoot,
}));

const { clearStaleCaches } = await import('../lib/cache-utils.js');

describe('clearStaleCaches', () => {
  beforeEach(async () => {
    // Create temporary cache directory
    testCacheRoot = path.join(os.tmpdir(), `heuristic-mcp-test-${Date.now()}`);
    await fs.mkdir(path.join(testCacheRoot, 'heuristic-mcp'), { recursive: true });
  });

  afterEach(async () => {
    // Cleanup test directory
    try {
      await fs.rm(testCacheRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('should keep cache with active lock', async () => {
    const cacheDir = path.join(testCacheRoot, 'heuristic-mcp', 'test-active');
    await fs.mkdir(cacheDir, { recursive: true });

    // Create meta.json
    await fs.writeFile(
      path.join(cacheDir, 'meta.json'),
      JSON.stringify({
        workspace: '/some/path',
        filesIndexed: 10,
        chunksStored: 100,
        lastSaveTime: new Date().toISOString(),
      })
    );

    // Create lock file with current process PID (active)
    await fs.writeFile(
      path.join(cacheDir, 'server.lock.json'),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      })
    );

    const results = await clearStaleCaches({
      dryRun: true,
      logger: null,
    });

    expect(results.removed).toBe(0);
    expect(results.kept).toBe(1);
    expect(results.decisions[0].reason).toBe('active_lock');
  });

  it('should remove empty cache that is old', async () => {
    const cacheDir = path.join(testCacheRoot, 'heuristic-mcp', 'test-empty');
    await fs.mkdir(cacheDir, { recursive: true });

    const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago

    await fs.writeFile(
      path.join(cacheDir, 'meta.json'),
      JSON.stringify({
        workspace: '/some/path',
        filesIndexed: 0,
        chunksStored: 0,
        lastSaveTime: new Date(oldTime).toISOString(),
      })
    );

    const results = await clearStaleCaches({
      emptyThresholdHours: 24,
      dryRun: true,
      logger: null,
    });

    expect(results.removed).toBe(1);
    expect(results.kept).toBe(0);
    expect(results.decisions[0].reason).toBe('empty_cache');
  });

  it('should identify temporary workspace and remove when old', async () => {
    const cacheDir = path.join(testCacheRoot, 'heuristic-mcp', 'test-temp');
    await fs.mkdir(cacheDir, { recursive: true });

    const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago

    await fs.writeFile(
      path.join(cacheDir, 'meta.json'),
      JSON.stringify({
        workspace: path.join(os.tmpdir(), 'temp-workspace-123'),
        filesIndexed: 10,
        chunksStored: 100,
        lastSaveTime: new Date(oldTime).toISOString(),
      })
    );

    const results = await clearStaleCaches({
      tempThresholdHours: 24,
      dryRun: true,
      logger: null,
    });

    expect(results.removed).toBe(1);
    expect(results.kept).toBe(0);
    expect(results.decisions[0].reason).toBe('temp_workspace');
  });

  it('should keep cache with recent activity', async () => {
    const cacheDir = path.join(testCacheRoot, 'heuristic-mcp', 'test-recent');
    await fs.mkdir(cacheDir, { recursive: true });

    await fs.writeFile(
      path.join(cacheDir, 'meta.json'),
      JSON.stringify({
        workspace: '/some/path',
        filesIndexed: 10,
        chunksStored: 100,
        lastSaveTime: new Date().toISOString(), // Very recent
      })
    );

    const results = await clearStaleCaches({
      safetyWindowMinutes: 10,
      dryRun: true,
      logger: null,
    });

    expect(results.removed).toBe(0);
    expect(results.kept).toBe(1);
    expect(results.decisions[0].reason).toBe('recent_activity');
  });

  it('should keep valid, healthy cache', async () => {
    const cacheDir = path.join(testCacheRoot, 'heuristic-mcp', 'test-valid');
    await fs.mkdir(cacheDir, { recursive: true });

    await fs.writeFile(
      path.join(cacheDir, 'meta.json'),
      JSON.stringify({
        workspace: process.cwd(), // Current directory exists
        filesIndexed: 50,
        chunksStored: 500,
        lastSaveTime: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
      })
    );

    const results = await clearStaleCaches({
      maxUnusedDays: 30,
      dryRun: true,
      logger: null,
    });

    expect(results.removed).toBe(0);
    expect(results.kept).toBe(1);
    expect(results.decisions[0].reason).toBe('valid_cache');
  });

  it('should execute actual removal when dryRun is false', async () => {
    const cacheDir = path.join(testCacheRoot, 'heuristic-mcp', 'test-remove');
    await fs.mkdir(cacheDir, { recursive: true });

    const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago

    await fs.writeFile(
      path.join(cacheDir, 'meta.json'),
      JSON.stringify({
        workspace: '/some/path',
        filesIndexed: 0,
        chunksStored: 0,
        lastSaveTime: new Date(oldTime).toISOString(),
      })
    );

    const results = await clearStaleCaches({
      emptyThresholdHours: 24,
      dryRun: false,
      logger: null,
    });

    expect(results.removed).toBe(1);
    expect(results.kept).toBe(0);
    expect(results.dryRun).toBe(false);

    // Verify cache directory was actually removed
    try {
      await fs.access(cacheDir);
      expect.fail('Cache directory should have been removed');
    } catch (err) {
      expect(err.code).toBe('ENOENT');
    }
  });
});
