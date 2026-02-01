import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { getGlobalCacheDir } from './config.js';

/**
 * Check if a process is running
 */
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // On Windows, EPERM can happen even if process exists
    if (err && err.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

/**
 * Normalize workspace path for comparison
 * - Resolves symlinks
 * - Lowercase on Windows
 * - Normalizes path separators
 */
async function normalizeWorkspacePath(workspacePath) {
  if (!workspacePath) return null;

  try {
    let normalized = workspacePath;

    // Resolve symlinks if path exists
    try {
      normalized = await fs.realpath(normalized);
    } catch {
      // Path doesn't exist, use as-is
    }

    // Lowercase on Windows for case-insensitive comparison
    if (process.platform === 'win32') {
      normalized = normalized.toLowerCase();
    }

    // Normalize path separators
    normalized = path.normalize(normalized);

    return normalized;
  } catch {
    return workspacePath; // Return original if normalization fails
  }
}

/**
 * Check if workspace path indicates a temporary/test workspace
 */
function isTemporaryWorkspace(workspacePath) {
  if (!workspacePath) return false;

  const normalized = workspacePath.toLowerCase();
  const patterns = ['temp-workspace', '.tmp', '\\temp\\', '/tmp/', '\\\\temp\\\\'];

  if (patterns.some((p) => normalized.includes(p))) {
    return true;
  }

  // Check if under OS temp directory
  try {
    const tempDir = os.tmpdir().toLowerCase();
    return normalized.startsWith(tempDir);
  } catch {
    return false;
  }
}

/**
 * Get timestamp from progress data
 */
function getProgressTimestamp(cacheInfo) {
  if (cacheInfo.progress?.updatedAt) {
    const timestamp = Date.parse(cacheInfo.progress.updatedAt);
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }

  // Fallback to file mtime
  if (cacheInfo.stats.progressFile) {
    return cacheInfo.stats.progressFile.mtimeMs;
  }

  return 0;
}

/**
 * Check if progress was updated recently
 */
function hasRecentProgress(cacheInfo, thresholdMs = 5 * 60 * 1000) {
  if (!cacheInfo.progress) return false;

  const progressTime = getProgressTimestamp(cacheInfo);
  return Date.now() - progressTime < thresholdMs;
}

/**
 * Safe file stat - returns null on error
 */
async function safeStat(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

/**
 * Safe JSON parse - returns null on error
 */
async function safeReadJson(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Collect comprehensive cache information
 */
async function collectCacheInfo(cacheDir) {
  const cacheId = path.basename(cacheDir);
  const errors = [];

  // File paths
  const metaPath = path.join(cacheDir, 'meta.json');
  const progressPath = path.join(cacheDir, 'progress.json');
  const lockPath = path.join(cacheDir, 'server.lock.json');
  const embeddingsJsonPath = path.join(cacheDir, 'embeddings.json');
  const vectorsBinPath = path.join(cacheDir, 'vectors.bin');
  const vectorsSqlitePath = path.join(cacheDir, 'vectors.sqlite');
  const annIndexPath = path.join(cacheDir, 'ann-index.bin');

  // Read metadata
  const [meta, progress, lock] = await Promise.all([
    safeReadJson(metaPath),
    safeReadJson(progressPath),
    safeReadJson(lockPath),
  ]);

  // Gather file stats
  const [
    cacheDirStat,
    metaFileStat,
    progressFileStat,
    lockFileStat,
    embeddingsJsonStat,
    vectorsBinStat,
    vectorsSqliteStat,
    annIndexStat,
  ] = await Promise.all([
    safeStat(cacheDir),
    safeStat(metaPath),
    safeStat(progressPath),
    safeStat(lockPath),
    safeStat(embeddingsJsonPath),
    safeStat(vectorsBinPath),
    safeStat(vectorsSqlitePath),
    safeStat(annIndexPath),
  ]);

  // Determine embeddings file (prefer binary/sqlite over JSON)
  const embeddingsFileStat = vectorsBinStat || vectorsSqliteStat || embeddingsJsonStat;

  // Extract workspace path
  const workspacePath = meta?.workspace || null;

  // Check workspace existence
  let workspaceExists = false;
  if (workspacePath) {
    try {
      await fs.access(workspacePath);
      workspaceExists = true;
    } catch {
      workspaceExists = false;
    }
  }

  // Normalize workspace path
  const workspacePathNormalized = await normalizeWorkspacePath(workspacePath);

  // Calculate lastActivityMs from all known timestamps
  const timestamps = [
    meta?.lastSaveTime ? Date.parse(meta.lastSaveTime) : null,
    getProgressTimestamp({ progress, stats: { progressFile: progressFileStat } }),
    lock?.startedAt ? Date.parse(lock.startedAt) : null,
    cacheDirStat?.mtimeMs,
    embeddingsFileStat?.mtimeMs,
    annIndexStat?.mtimeMs,
  ].filter((t) => t && Number.isFinite(t));

  const lastActivityMs = timestamps.length > 0 ? Math.max(...timestamps) : 0;

  // Determine if cache is active
  let isActive = false;

  // Check lock file with valid PID
  if (lock && Number.isInteger(lock.pid)) {
    isActive = isProcessRunning(lock.pid);
  }

  return {
    cacheDir,
    cacheId,
    meta,
    progress,
    lock,
    stats: {
      cacheDir: cacheDirStat,
      metaFile: metaFileStat,
      progressFile: progressFileStat,
      lockFile: lockFileStat,
      embeddingsFile: embeddingsFileStat,
      annIndexFile: annIndexStat,
    },
    workspacePath,
    workspacePathNormalized,
    workspaceExists,
    lastActivityMs,
    isActive,
    errors,
  };
}

/**
 * Evaluate a single cache using the safe decision pipeline
 */
function evaluateCache(cacheInfo, thresholds) {
  const now = Date.now();
  const age = now - cacheInfo.lastActivityMs;

  // Step 1: Keep if active or within safety window
  if (cacheInfo.isActive || age < thresholds.safetyWindowMs) {
    return {
      action: 'KEEP',
      reason: cacheInfo.isActive ? 'active_lock' : 'recent_activity',
      details: {
        isActive: cacheInfo.isActive,
        lockPid: cacheInfo.lock?.pid,
        ageMs: age,
      },
    };
  }

  // Step 2: No meta.json
  if (!cacheInfo.meta) {
    const dirAge = now - (cacheInfo.stats.cacheDir?.mtimeMs || 0);
    if (dirAge > thresholds.staleNoMetaMs && !hasRecentProgress(cacheInfo)) {
      return {
        action: 'REMOVE',
        reason: 'no_meta_stale',
        details: { ageMs: dirAge },
      };
    }
    return {
      action: 'KEEP',
      reason: 'initializing',
      details: { ageMs: dirAge },
    };
  }

  // Step 3: Temporary workspace (check BEFORE missing workspace - shorter threshold!)
  // This ensures temp workspaces use 24h threshold instead of 7-day grace period
  if (isTemporaryWorkspace(cacheInfo.workspacePath)) {
    if (age > thresholds.tempThresholdMs) {
      return {
        action: 'REMOVE',
        reason: 'temp_workspace',
        details: {
          workspace: cacheInfo.workspacePath,
          ageMs: age,
        },
      };
    }
    // Recent temp workspace - keep for now
    return {
      action: 'KEEP',
      reason: 'recent_temp_workspace',
      details: {
        workspace: cacheInfo.workspacePath,
        ageMs: age,
      },
    };
  }

  // Step 4: Missing workspace (non-temp workspaces only, due to Step 3 early return)
  if (cacheInfo.workspacePath && !cacheInfo.workspaceExists) {
    if (age > thresholds.workspaceGraceMs) {
      return {
        action: 'REMOVE',
        reason: 'workspace_missing',
        details: {
          workspace: cacheInfo.workspacePath,
          ageMs: age,
        },
      };
    }
    return {
      action: 'KEEP',
      reason: 'workspace_grace_period',
      details: {
        workspace: cacheInfo.workspacePath,
        ageMs: age,
      },
    };
  }

  // Step 5: Empty cache
  const filesIndexed = cacheInfo.meta.filesIndexed ?? 0;
  const chunksStored = cacheInfo.meta.chunksStored ?? 0;

  if (filesIndexed === 0 || chunksStored === 0) {
    if (age > thresholds.emptyThresholdMs) {
      return {
        action: 'REMOVE',
        reason: 'empty_cache',
        details: {
          filesIndexed,
          chunksStored,
          ageMs: age,
        },
      };
    }
    return {
      action: 'KEEP',
      reason: 'recent_empty',
      details: {
        filesIndexed,
        chunksStored,
        ageMs: age,
      },
    };
  }

  // Step 6: Stuck indexing
  if (cacheInfo.progress && !hasRecentProgress(cacheInfo, thresholds.safetyWindowMs)) {
    const progressAge = now - getProgressTimestamp(cacheInfo);
    if (progressAge > thresholds.staleProgressMs) {
      return {
        action: 'REMOVE',
        reason: 'stuck_indexing',
        details: {
          progressAgeMs: progressAge,
          lastProgress: cacheInfo.progress,
        },
      };
    }
  }

  // Step 7: Long unused
  if (age > thresholds.maxUnusedMs) {
    return {
      action: 'REMOVE',
      reason: 'long_unused',
      details: { ageMs: age },
    };
  }

  // Step 8: Default - keep
  return {
    action: 'KEEP',
    reason: 'valid_cache',
    details: {
      filesIndexed,
      chunksStored,
      ageMs: age,
    },
  };
}

/**
 * Find duplicate workspace caches
 */
function findDuplicateWorkspaces(cacheInfos) {
  const workspaceMap = new Map(); // normalized workspace -> [cacheInfos]

  for (const info of cacheInfos) {
    if (!info.workspacePathNormalized) continue;

    // Key includes embedding model to avoid deleting caches for different models
    const key = `${info.workspacePathNormalized}::${info.meta?.embeddingModel || 'default'}`;

    if (!workspaceMap.has(key)) {
      workspaceMap.set(key, []);
    }
    workspaceMap.get(key).push(info);
  }

  const duplicates = [];
  for (const [key, infos] of workspaceMap) {
    if (infos.length > 1) {
      // Sort by lastActivityMs descending
      infos.sort((a, b) => b.lastActivityMs - a.lastActivityMs);

      // Keep newest, mark others for removal (if not active)
      for (let i = 1; i < infos.length; i++) {
        if (!infos[i].isActive) {
          duplicates.push({
            info: infos[i],
            action: 'REMOVE',
            reason: 'duplicate_workspace',
            details: {
              newestCache: infos[0].cacheId,
              workspace: key,
              ageMs: Date.now() - infos[i].lastActivityMs,
            },
          });
        }
      }
    }
  }

  return duplicates;
}

/**
 * Main cache cleanup function with intelligent sanitization
 */
export async function clearStaleCaches(options = {}) {
  const config = {
    staleNoMetaHours: 6,
    emptyThresholdHours: 24,
    workspaceGraceDays: 7,
    maxUnusedDays: 30,
    tempThresholdHours: 24,
    staleProgressHours: 6,
    safetyWindowMinutes: 10,
    removeDuplicates: true,
    dryRun: false,
    logger: console,
    ...options,
  };

  // Convert to milliseconds
  const thresholds = {
    staleNoMetaMs: config.staleNoMetaHours * 60 * 60 * 1000,
    emptyThresholdMs: config.emptyThresholdHours * 60 * 60 * 1000,
    workspaceGraceMs: config.workspaceGraceDays * 24 * 60 * 60 * 1000,
    maxUnusedMs: config.maxUnusedDays * 24 * 60 * 60 * 1000,
    tempThresholdMs: config.tempThresholdHours * 60 * 60 * 1000,
    staleProgressMs: config.staleProgressHours * 60 * 60 * 1000,
    safetyWindowMs: config.safetyWindowMinutes * 60 * 1000,
  };

  const globalCacheRoot = path.join(getGlobalCacheDir(), 'heuristic-mcp');
  const cacheDirs = await fs.readdir(globalCacheRoot).catch(() => []);

  if (cacheDirs.length === 0) {
    return { removed: 0, kept: 0, dryRun: config.dryRun, decisions: [] };
  }

  // Step 1: Collect all cache info
  const cacheInfos = await Promise.all(
    cacheDirs.map((dir) => collectCacheInfo(path.join(globalCacheRoot, dir)))
  );

  // Step 2: Evaluate each cache individually
  const decisions = cacheInfos.map((info) => {
    const evaluation = evaluateCache(info, thresholds);
    return {
      cacheDir: info.cacheDir,
      cacheId: info.cacheId,
      info,
      ...evaluation,
    };
  });

  // Step 3: Find duplicates
  if (config.removeDuplicates) {
    const duplicates = findDuplicateWorkspaces(cacheInfos);
    for (const dup of duplicates) {
      // Override decision if not already marked for removal
      const existing = decisions.find((d) => d.cacheId === dup.info.cacheId);
      if (existing && existing.action === 'KEEP') {
        existing.action = dup.action;
        existing.reason = dup.reason;
        existing.details = dup.details;
      }
    }
  }

  // Step 4: Execute removals
  let removed = 0;
  let kept = 0;

  for (const decision of decisions) {
    if (decision.action === 'REMOVE') {
      if (!config.dryRun) {
        try {
          await fs.rm(decision.cacheDir, { recursive: true, force: true });
          removed++;
          if (config.logger) {
            config.logger.info(
              `[Cache] Removed ${decision.cacheId}: ${decision.reason} (${formatAge(decision.details.ageMs)})`
            );
          }
        } catch (err) {
          if (config.logger) {
            config.logger.warn(
              `[Cache] Failed to remove ${decision.cacheId}: ${err.message}`
            );
          }
          // Count as kept if removal failed
          kept++;
          decision.action = 'KEEP';
          decision.reason = 'removal_failed';
          decision.details.error = err.message;
        }
      } else {
        removed++;
        if (config.logger) {
          config.logger.info(
            `[Cache] Would remove ${decision.cacheId}: ${decision.reason} (${formatAge(decision.details.ageMs)})`
          );
        }
      }
    } else {
      kept++;
    }
  }

  if (removed > 0 && config.logger) {
    config.logger.info(
      `[Cache] ${config.dryRun ? 'Would remove' : 'Removed'} ${removed} stale cache ${removed === 1 ? 'directory' : 'directories'}.`
    );
  }

  return {
    removed,
    kept,
    dryRun: config.dryRun,
    decisions,
  };
}

/**
 * Format age in human-readable form
 */
function formatAge(ms) {
  if (!Number.isFinite(ms)) return 'unknown';

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
