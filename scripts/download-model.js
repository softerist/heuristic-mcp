import path from 'path';

import { getGlobalCacheDir } from '../lib/config.js';

async function downloadModel() {
  const globalCacheDir = path.join(getGlobalCacheDir(), 'xenova');

  try {
    const transformers = await import('@huggingface/transformers');
    const { pipeline, env } = transformers;

    env.cacheDir = globalCacheDir;

    console.info(`[Model Setup] Pre-caching model to: ${globalCacheDir}`);
    console.info(`[Model Setup] Downloading 'jinaai/jina-embeddings-v2-base-code'...`);

    await pipeline('feature-extraction', 'jinaai/jina-embeddings-v2-base-code');

    console.info(`[Model Setup] ✅ Model cached successfully!`);
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
      console.warn(
        '[Model Setup] ⚠️  Transformers not available yet; skipping model pre-download.'
      );
      console.warn(
        '[Model Setup] This is okay! The server will attempt to download it when started.'
      );
      return;
    }
    console.warn(`[Model Setup] ⚠️  Constructive warning: Failed to pre-download model.`);
    console.warn(
      '[Model Setup] This is okay! The server will attempt to download it when started.'
    );
    console.warn(`[Model Setup] Error details: ${error.message}`);
  }
}

downloadModel();
