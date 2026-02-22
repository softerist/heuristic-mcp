import fs from 'fs/promises';
import { loadConfig } from '../lib/config.js';

async function clearCache() {
  try {
    const config = await loadConfig(process.cwd());
    const cacheDir = config.cacheDirectory;

    await fs.rm(cacheDir, { recursive: true, force: true });
    console.info(`Cache cleared successfully: ${cacheDir}`);
    console.info('Next startup will perform a full reindex.');
  } catch (error) {
    console.error(`Error clearing cache: ${error.message}`);
    process.exit(1);
  }
}

clearCache();
