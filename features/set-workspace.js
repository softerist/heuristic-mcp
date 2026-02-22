import path from 'path';
import fs from 'fs/promises';
import { acquireWorkspaceLock, releaseWorkspaceLock } from '../lib/server-lifecycle.js';
import {
  getWorkspaceCachePath,
  getWorkspaceCachePathCandidates,
} from '../lib/workspace-cache-key.js';
import { cleanupStaleBinaryArtifacts } from '../lib/vector-store-binary.js';

function getWorkspaceCacheDir(workspacePath, globalCacheDir) {
  return getWorkspaceCachePath(workspacePath, globalCacheDir);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveWorkspaceCacheDir(workspacePath, globalCacheDir) {
  const candidates = getWorkspaceCachePathCandidates(workspacePath, globalCacheDir);

  if (await pathExists(candidates.canonical)) {
    return { cacheDirectory: candidates.canonical, mode: 'canonical' };
  }
  if (
    candidates.compatDriveCase !== candidates.canonical &&
    (await pathExists(candidates.compatDriveCase))
  ) {
    return { cacheDirectory: candidates.compatDriveCase, mode: 'compat-drivecase' };
  }
  if (candidates.legacy !== candidates.canonical && (await pathExists(candidates.legacy))) {
    return { cacheDirectory: candidates.legacy, mode: 'legacy' };
  }
  return { cacheDirectory: candidates.canonical, mode: 'canonical' };
}

export function getToolDefinition() {
  return {
    name: 'f_set_workspace',
    description:
      'Changes the current workspace path at runtime. This updates the search directory and cache, and optionally triggers a full reindex. Useful for multi-project workflows.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: {
          type: 'string',
          description: 'Absolute path to the new workspace directory',
        },
        reindex: {
          type: 'boolean',
          description: 'Whether to trigger a full reindex after switching (default: true)',
          default: true,
        },
      },
      required: ['workspacePath'],
    },
    annotations: {
      title: 'Set Workspace',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

export class SetWorkspaceFeature {
  constructor(config, cache, indexer, getGlobalCacheDir) {
    this.config = config;
    this.cache = cache;
    this.indexer = indexer;
    this.getGlobalCacheDir = getGlobalCacheDir;
  }

  async execute({ workspacePath, reindex = true }) {
    if (!workspacePath || typeof workspacePath !== 'string') {
      return {
        success: false,
        error: 'workspacePath is required and must be a string',
      };
    }

    const normalizedPath = path.resolve(workspacePath);

    try {
      const stat = await fs.stat(normalizedPath);
      if (!stat.isDirectory()) {
        return {
          success: false,
          error: `Path is not a directory: ${normalizedPath}`,
        };
      }
    } catch (err) {
      return {
        success: false,
        error: `Cannot access directory: ${normalizedPath} (${err.message})`,
      };
    }

    const previousWorkspace = this.config.searchDirectory;
    const previousCache = this.config.cacheDirectory;

    this.config.searchDirectory = normalizedPath;

    const globalCacheDir = this.getGlobalCacheDir();
    const cacheResolution = await resolveWorkspaceCacheDir(normalizedPath, globalCacheDir);
    let newCacheDir = cacheResolution.cacheDirectory;
    if (this.config.verbose || cacheResolution.mode !== 'canonical') {
      console.info(`[SetWorkspace] Cache resolution mode: ${cacheResolution.mode}`);
    }

    const legacyPath = path.join(normalizedPath, '.smart-coding-cache');
    try {
      const legacyStats = await fs.stat(legacyPath);
      if (legacyStats.isDirectory()) {
        newCacheDir = legacyPath;
      }
    } catch {}
    this.config.cacheDirectory = newCacheDir;

    try {
      await fs.mkdir(newCacheDir, { recursive: true });
    } catch (err) {
      this.config.searchDirectory = previousWorkspace;
      this.config.cacheDirectory = previousCache;
      return {
        success: false,
        error: `Failed to create cache directory: ${err.message}`,
      };
    }

    const lock = await acquireWorkspaceLock({
      cacheDirectory: newCacheDir,
      workspaceDir: normalizedPath,
    });
    if (!lock.acquired) {
      this.config.searchDirectory = previousWorkspace;
      this.config.cacheDirectory = previousCache;
      return {
        success: false,
        error: `Workspace is already locked by another server (pid ${lock.ownerPid ?? 'unknown'})`,
      };
    }
    let indexerUpdateError = null;

    if (this.indexer) {
      if (typeof this.indexer.terminateWorkers === 'function') {
        try {
          await this.indexer.terminateWorkers();
        } catch (err) {
          console.warn(`[SetWorkspace] Failed to terminate workers: ${err.message}`);
        }
      }
      try {
        if (typeof this.indexer.updateWorkspaceState === 'function') {
          await this.indexer.updateWorkspaceState({ restartWatcher: true });
        } else {
          this.indexer.workspaceRoot = normalizedPath;
          this.indexer.workspaceRootReal = null;
          if (this.config.watchFiles && typeof this.indexer.setupFileWatcher === 'function') {
            await this.indexer.setupFileWatcher();
          }
        }
      } catch (err) {
        indexerUpdateError = err;
      }
    }

    if (indexerUpdateError) {
      this.config.searchDirectory = previousWorkspace;
      this.config.cacheDirectory = previousCache;
      await releaseWorkspaceLock({ cacheDirectory: newCacheDir });
      if (this.indexer) {
        try {
          if (typeof this.indexer.updateWorkspaceState === 'function') {
            await this.indexer.updateWorkspaceState({ restartWatcher: true });
          } else {
            this.indexer.workspaceRoot = previousWorkspace;
            this.indexer.workspaceRootReal = null;
            if (this.config.watchFiles && typeof this.indexer.setupFileWatcher === 'function') {
              await this.indexer.setupFileWatcher();
            }
          }
        } catch (rollbackErr) {
          console.warn(`[SetWorkspace] Failed to rollback indexer state: ${rollbackErr.message}`);
        }
      }
      return {
        success: false,
        error: `Failed to update workspace state: ${indexerUpdateError.message}`,
      };
    }

    if (previousCache) {
      await releaseWorkspaceLock({ cacheDirectory: previousCache });
    }

    if (this.cache && typeof this.cache.load === 'function') {
      try {
        if (typeof this.cache.clearInMemoryState === 'function') {
          this.cache.clearInMemoryState();
        }
        if (this.config.vectorStoreFormat === 'binary') {
          await cleanupStaleBinaryArtifacts(newCacheDir);
        }
        await this.cache.load();
      } catch (err) {
        console.warn(`[SetWorkspace] Failed to load cache: ${err.message}`);
      }
    }

    let reindexStatus = null;
    if (reindex && this.indexer && typeof this.indexer.indexAll === 'function') {
      try {
        this.indexer.indexAll().catch((err) => {
          console.warn(`[SetWorkspace] Reindex failed: ${err.message}`);
        });
        reindexStatus = 'started';
      } catch (err) {
        reindexStatus = `failed: ${err.message}`;
      }
    } else if (!reindex) {
      reindexStatus = 'skipped';
    }

    return {
      success: true,
      previousWorkspace,
      newWorkspace: normalizedPath,
      cacheDirectory: newCacheDir,
      reindexStatus,
    };
  }
}

export function createHandleToolCall(featureInstance) {
  return async (request, instance) => {
    const activeInstance = instance ?? featureInstance;
    const args = request.params?.arguments || {};
    const { workspacePath, reindex } = args;

    const result = await activeInstance.execute({
      workspacePath,
      reindex: reindex !== false,
    });

    if (result.success) {
      let message = `✓ Workspace switched to: **${result.newWorkspace}**\n`;
      message += `\n- Previous: \`${result.previousWorkspace || '(none)'}\``;
      message += `\n- Cache: \`${result.cacheDirectory}\``;
      if (result.reindexStatus) {
        message += `\n- Reindex: ${result.reindexStatus}`;
      }
      return {
        content: [{ type: 'text', text: message }],
      };
    } else {
      return {
        content: [{ type: 'text', text: `Error: ${result.error}` }],
      };
    }
  };
}

export { getWorkspaceCacheDir };
