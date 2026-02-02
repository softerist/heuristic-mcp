/**
 * Runtime Workspace Switching Tool
 *
 * Changes the workspace path at runtime, reinitializing the cache
 * and optionally triggering reindexing.
 */

import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { acquireWorkspaceLock, releaseWorkspaceLock } from '../lib/server-lifecycle.js';

/**
 * Generate a workspace-specific cache directory path
 */
function getWorkspaceCacheDir(workspacePath, globalCacheDir) {
  const normalized = path.resolve(workspacePath);
  const hash = crypto.createHash('md5').update(normalized).digest('hex').slice(0, 12);
  return path.join(globalCacheDir, 'heuristic-mcp', hash);
}

// MCP Tool definition
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

/**
 * Create the SetWorkspace feature class
 * This needs access to shared state (config, cache, indexer) to actually perform the switch
 */
export class SetWorkspaceFeature {
  constructor(config, cache, indexer, getGlobalCacheDir) {
    this.config = config;
    this.cache = cache;
    this.indexer = indexer;
    this.getGlobalCacheDir = getGlobalCacheDir;
  }

  async execute({ workspacePath, reindex = true }) {
    // Validate workspace path
    if (!workspacePath || typeof workspacePath !== 'string') {
      return {
        success: false,
        error: 'workspacePath is required and must be a string',
      };
    }

    const normalizedPath = path.resolve(workspacePath);

    // Check if directory exists
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

    // Update config
    this.config.searchDirectory = normalizedPath;

    // Calculate new cache directory (match config.js behavior)
    const globalCacheDir = this.getGlobalCacheDir();
    let newCacheDir = getWorkspaceCacheDir(normalizedPath, globalCacheDir);

    // Prefer legacy local cache if present
    const legacyPath = path.join(normalizedPath, '.smart-coding-cache');
    try {
      const legacyStats = await fs.stat(legacyPath);
      if (legacyStats.isDirectory()) {
        newCacheDir = legacyPath;
      }
    } catch {
      // ignore missing legacy cache
    }
    this.config.cacheDirectory = newCacheDir;

    // Create cache directory if needed
    try {
      await fs.mkdir(newCacheDir, { recursive: true });
    } catch (err) {
      // Revert config on failure
      this.config.searchDirectory = previousWorkspace;
      this.config.cacheDirectory = previousCache;
      return {
        success: false,
        error: `Failed to create cache directory: ${err.message}`,
      };
    }

    // Acquire new workspace lock before proceeding
    const lock = await acquireWorkspaceLock({
      cacheDirectory: newCacheDir,
      workspaceDir: normalizedPath,
    });
    if (!lock.acquired) {
      // Revert config on failure
      this.config.searchDirectory = previousWorkspace;
      this.config.cacheDirectory = previousCache;
      return {
        success: false,
        error: `Workspace is already locked by another server (pid ${lock.ownerPid ?? 'unknown'})`,
      };
    }

    // Release old workspace lock after new lock is acquired
    if (previousCache) {
      await releaseWorkspaceLock({ cacheDirectory: previousCache });
    }

    // Update indexer's workspace root and related state
    if (this.indexer) {
      if (typeof this.indexer.terminateWorkers === 'function') {
        await this.indexer.terminateWorkers();
      }
      if (typeof this.indexer.updateWorkspaceState === 'function') {
        await this.indexer.updateWorkspaceState({ restartWatcher: true });
      } else {
        this.indexer.workspaceRoot = normalizedPath;
        this.indexer.workspaceRootReal = null; // Reset cached realpath
        if (this.config.watchFiles && typeof this.indexer.setupFileWatcher === 'function') {
          await this.indexer.setupFileWatcher();
        }
      }
    }

    // Re-initialize cache for new workspace if cache has a load method
    if (this.cache && typeof this.cache.load === 'function') {
      try {
        await this.cache.load();
      } catch (err) {
        console.warn(`[SetWorkspace] Failed to load cache: ${err.message}`);
      }
    }

    // Optionally trigger reindex
    let reindexStatus = null;
    if (reindex && this.indexer && typeof this.indexer.indexAll === 'function') {
      try {
        // Start indexing asynchronously
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

// Tool handler (needs instance context, so this is a factory)
export function createHandleToolCall(featureInstance) {
  return async (request) => {
    const args = request.params?.arguments || {};
    const { workspacePath, reindex } = args;

    const result = await featureInstance.execute({
      workspacePath,
      reindex: reindex !== false, // Default to true
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

// Export for use in registration
export { getWorkspaceCacheDir };
