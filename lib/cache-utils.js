import fs from 'fs/promises';
import path from 'path';
import { getGlobalCacheDir } from './config.js';

export async function clearStaleCaches({ maxAgeMs = 6 * 60 * 60 * 1000, logger = console } = {}) {
  const globalCacheRoot = path.join(getGlobalCacheDir(), 'heuristic-mcp');
  const cacheDirs = await fs.readdir(globalCacheRoot).catch(() => []);
  if (cacheDirs.length === 0) return 0;

  const now = Date.now();
  let removed = 0;

  for (const dir of cacheDirs) {
    const cacheDir = path.join(globalCacheRoot, dir);
    const metaFile = path.join(cacheDir, 'meta.json');
    try {
      await fs.access(metaFile);
      continue; // valid cache with metadata
    } catch (err) {
      if (err.code !== 'ENOENT') continue;
      try {
        const stats = await fs.stat(cacheDir);
        const ageMs = now - stats.mtimeMs;
        if (ageMs < maxAgeMs) {
          continue; // likely indexing in progress
        }

        let progressAgeMs = null;
        const progressFile = path.join(cacheDir, 'progress.json');
        try {
          const raw = await fs.readFile(progressFile, 'utf-8');
          const data = JSON.parse(raw);
          const updatedAt = Date.parse(data?.updatedAt);
          if (Number.isFinite(updatedAt)) {
            progressAgeMs = now - updatedAt;
          }
        } catch {
          // ignore progress read errors
        }
        if (progressAgeMs === null) {
          try {
            const progressStats = await fs.stat(progressFile);
            progressAgeMs = now - progressStats.mtimeMs;
          } catch {
            // no progress file
          }
        }

        if (progressAgeMs !== null && progressAgeMs < maxAgeMs) {
          continue; // progress updated recently
        }

        await fs.rm(cacheDir, { recursive: true, force: true });
        removed++;
      } catch {
        // ignore failures per dir
      }
    }
  }

  if (removed > 0) {
    logger.info(`[Cache] Removed ${removed} stale cache director${removed === 1 ? 'y' : 'ies'}.`);
  }

  return removed;
}
