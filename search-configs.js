import { loadConfig } from './lib/config.js';
import { EmbeddingsCache } from './lib/cache.js';
import { HybridSearch } from './features/hybrid-search.js';
import { pipeline, env } from '@huggingface/transformers';

// Force same thread config as server
if (env?.backends?.onnx) {
  env.backends.onnx.numThreads = 2;
  if (env.backends.onnx.wasm) {
    env.backends.onnx.wasm.numThreads = 2;
  }
}

async function searchConfigs() {
  const config = await loadConfig(process.cwd());
  const cache = new EmbeddingsCache(config);
  await cache.load();

  const embedder = async (text) => {
    const pipe = await pipeline('feature-extraction', config.embeddingModel, {
      session_options: { numThreads: 2 },
      dtype: 'fp32',
    });
    return pipe(text, { pooling: 'mean', normalize: true });
  };

  const searcher = new HybridSearch(embedder, cache, config);
  const { results } = await searcher.search('configuration files, config, settings');

  console.info(JSON.stringify(results, null, 2));
}

searchConfigs().catch((err) => {
  console.error(err);
  process.exit(1);
});
