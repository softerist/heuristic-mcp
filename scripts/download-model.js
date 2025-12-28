
import { pipeline, env } from '@xenova/transformers';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getGlobalCacheDir } from '../lib/config.js';

// Force cache directory to global location
const globalCacheDir = path.join(getGlobalCacheDir(), 'xenova');
env.cacheDir = globalCacheDir;

console.log(`[Model Setup] Pre-caching model to: ${globalCacheDir}`);

async function downloadModel() {
  try {
    // Check if network is available by pinging HF (simple check)
    // Actually, pipeline() will fail fast if network is down
    console.log(`[Model Setup] Downloading 'Xenova/all-MiniLM-L6-v2'...`);

    // This will download the model to the cache directory
    await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

    console.log(`[Model Setup] ✅ Model cached successfully!`);
  } catch (error) {
    console.warn(`[Model Setup] ⚠️  Constructive warning: Failed to pre-download model.`);
    console.warn(`[Model Setup] This is okay! The server will attempt to download it when started.`);
    console.warn(`[Model Setup] Error details: ${error.message}`);
    // Don't fail the install, just warn
  }
}

downloadModel();
