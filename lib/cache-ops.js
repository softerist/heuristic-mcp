import fs from 'fs/promises';
import { loadConfig } from './config.js';
import { clearStaleCaches } from './cache-utils.js';

export async function clearCache(workspaceDir) {
  const effectiveWorkspace = workspaceDir || process.cwd();
  const activeConfig = await loadConfig(effectiveWorkspace);

  if (!activeConfig.enableCache) {
    console.info('[Cache] Cache disabled (enableCache=false); nothing to clear.');
    return;
  }

  try {
    await fs.rm(activeConfig.cacheDirectory, { recursive: true, force: true });
    console.info(`[Cache] Cleared cache directory: ${activeConfig.cacheDirectory}`);
    await clearStaleCaches();
  } catch (err) {
    console.error(`[Cache] Failed to clear cache: ${err.message}`);
    process.exit(1);
  }
}
