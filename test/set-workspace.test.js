import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

vi.mock('../lib/server-lifecycle.js', () => ({
  acquireWorkspaceLock: vi.fn(),
  releaseWorkspaceLock: vi.fn(),
}));

async function withTempDir(testFn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heuristic-workspace-'));
  let testError;
  try {
    await testFn(dir);
  } catch (error) {
    testError = error;
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  if (testError) throw testError;
}

function createMocks() {
  const cache = {
    load: async () => {},
  };
  const indexer = {
    terminateWorkers: async () => {},
    updateWorkspaceState: async () => {},
  };
  return { cache, indexer };
}

describe('SetWorkspaceFeature', () => {
  let acquireWorkspaceLock;
  let releaseWorkspaceLock;
  let SetWorkspaceFeature;
  let getWorkspaceCacheDir;

  beforeEach(async () => {
    const lifecycle = await import('../lib/server-lifecycle.js');
    acquireWorkspaceLock = lifecycle.acquireWorkspaceLock;
    releaseWorkspaceLock = lifecycle.releaseWorkspaceLock;
    acquireWorkspaceLock.mockReset();
    releaseWorkspaceLock.mockReset();

    const featureModule = await import('../features/set-workspace.js');
    SetWorkspaceFeature = featureModule.SetWorkspaceFeature;
    getWorkspaceCacheDir = featureModule.getWorkspaceCacheDir;
  });

  it('acquires new workspace lock and releases old lock', async () => {
    await withTempDir(async (dir) => {
      const oldWorkspace = path.join(dir, 'old');
      const newWorkspace = path.join(dir, 'new');
      const oldCache = path.join(dir, 'old-cache');
      await fs.mkdir(oldWorkspace, { recursive: true });
      await fs.mkdir(newWorkspace, { recursive: true });

      acquireWorkspaceLock.mockResolvedValue({ acquired: true, lockPath: 'lock.json' });
      releaseWorkspaceLock.mockResolvedValue();

      const config = {
        searchDirectory: oldWorkspace,
        cacheDirectory: oldCache,
        watchFiles: false,
      };
      const { cache, indexer } = createMocks();
      const feature = new SetWorkspaceFeature(config, cache, indexer, () => dir);

      const result = await feature.execute({ workspacePath: newWorkspace, reindex: false });

      expect(result.success).toBe(true);
      expect(result.newWorkspace).toBe(path.resolve(newWorkspace));

      expect(acquireWorkspaceLock).toHaveBeenCalledWith({
        cacheDirectory: getWorkspaceCacheDir(newWorkspace, dir),
        workspaceDir: path.resolve(newWorkspace),
      });
      expect(releaseWorkspaceLock).toHaveBeenCalledWith({ cacheDirectory: oldCache });
    });
  });

  it('fails when target workspace is already locked', async () => {
    await withTempDir(async (dir) => {
      const oldWorkspace = path.join(dir, 'old');
      const newWorkspace = path.join(dir, 'new');
      const oldCache = path.join(dir, 'old-cache');
      await fs.mkdir(oldWorkspace, { recursive: true });
      await fs.mkdir(newWorkspace, { recursive: true });
      acquireWorkspaceLock.mockResolvedValue({ acquired: false, ownerPid: 1234 });

      const config = {
        searchDirectory: oldWorkspace,
        cacheDirectory: oldCache,
        watchFiles: false,
      };
      const { cache, indexer } = createMocks();
      const feature = new SetWorkspaceFeature(config, cache, indexer, () => dir);

      const result = await feature.execute({ workspacePath: newWorkspace, reindex: false });

      expect(result.success).toBe(false);
      expect(config.searchDirectory).toBe(oldWorkspace);
      expect(config.cacheDirectory).toBe(oldCache);
    });
  });

  it('rolls back when indexer update fails', async () => {
    await withTempDir(async (dir) => {
      const oldWorkspace = path.join(dir, 'old');
      const newWorkspace = path.join(dir, 'new');
      const oldCache = path.join(dir, 'old-cache');
      await fs.mkdir(oldWorkspace, { recursive: true });
      await fs.mkdir(newWorkspace, { recursive: true });

      acquireWorkspaceLock.mockResolvedValue({ acquired: true, lockPath: 'lock.json' });
      releaseWorkspaceLock.mockResolvedValue();

      const config = {
        searchDirectory: oldWorkspace,
        cacheDirectory: oldCache,
        watchFiles: false,
      };
      const { cache, indexer } = createMocks();
      indexer.updateWorkspaceState = vi
        .fn()
        .mockRejectedValueOnce(new Error('update failed'))
        .mockResolvedValueOnce(undefined);
      const feature = new SetWorkspaceFeature(config, cache, indexer, () => dir);

      const result = await feature.execute({ workspacePath: newWorkspace, reindex: false });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to update workspace state');
      expect(config.searchDirectory).toBe(oldWorkspace);
      expect(config.cacheDirectory).toBe(oldCache);
      expect(indexer.updateWorkspaceState).toHaveBeenCalledTimes(2);
      expect(releaseWorkspaceLock).toHaveBeenCalledWith({
        cacheDirectory: getWorkspaceCacheDir(newWorkspace, dir),
      });
      expect(releaseWorkspaceLock).not.toHaveBeenCalledWith({ cacheDirectory: oldCache });
    });
  });
});
