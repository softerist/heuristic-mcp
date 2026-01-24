#!/usr/bin/env node
import fs from 'fs/promises';
import { loadConfig } from '../lib/config.js';

async function clearCache() {
  try {
    const config = await loadConfig(process.cwd());
    const cacheDir = config.cacheDirectory;

    // Remove cache directory
    await fs.rm(cacheDir, { recursive: true, force: true });
    console.log(`Cache cleared successfully: ${cacheDir}`);
    console.log('Next startup will perform a full reindex.');
  } catch (error) {
    console.error(`Error clearing cache: ${error.message}`);
    process.exit(1);
  }
}

clearCache();
