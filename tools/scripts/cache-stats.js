#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { loadConfig } from '../../lib/config.js';
import { BinaryVectorStore } from '../../lib/vector-store-binary.js';

async function main() {
  const args = process.argv.slice(2);
  const workspaceIndex = args.indexOf('--workspace');
  const workspaceDir = workspaceIndex !== -1 ? args[workspaceIndex + 1] : null;

  const config = await loadConfig(workspaceDir || process.cwd());
  const cacheDir = config.cacheDirectory;

  const metaPath = path.join(cacheDir, 'meta.json');
  const hashPath = path.join(cacheDir, 'file-hashes.json');
  const jsonPath = path.join(cacheDir, 'embeddings.json');

  const stats = {
    cacheDir,
    vectorStoreFormat: config.vectorStoreFormat,
    hasMeta: false,
    hasJson: false,
    hasBinary: false,
    vectorCount: 0,
    fileHashCount: 0,
  };

  try {
    const metaRaw = await fs.readFile(metaPath, 'utf-8');
    stats.hasMeta = true;
    stats.meta = JSON.parse(metaRaw);
  } catch {
    // ignore
  }

  try {
    const hashRaw = await fs.readFile(hashPath, 'utf-8');
    const hashes = JSON.parse(hashRaw);
    stats.fileHashCount = Object.keys(hashes).length;
  } catch {
    // ignore
  }

  try {
    const jsonRaw = await fs.readFile(jsonPath, 'utf-8');
    stats.hasJson = true;
    const parsed = JSON.parse(jsonRaw);
    if (Array.isArray(parsed)) {
      stats.jsonVectorCount = parsed.length;
    }
  } catch {
    // ignore
  }

  try {
    const store = await BinaryVectorStore.load(cacheDir);
    stats.hasBinary = true;
    stats.vectorCount = store.length;
    stats.binaryDim = store.dim;
  } catch {
    // ignore
  }

  console.log(JSON.stringify(stats, null, 2));
}

main().catch((err) => {
  console.error(`[cache-stats] ${err.message}`);
  process.exit(1);
});
