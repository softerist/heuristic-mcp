
import { loadConfig } from '../../lib/config.js';
import { EmbeddingsCache } from '../../lib/cache.js';
import { HybridSearch } from '../../features/hybrid-search.js';
import { pipeline, env } from '@huggingface/transformers';

// Force same thread config as server
env.backends.onnx.numThreads = 2;
env.backends.onnx.wasm.numThreads = 2;

async function runSearch(query) {
  const config = await loadConfig(process.cwd());
  const cache = new EmbeddingsCache(config);
  await cache.load();

  const embedder = async (text) => {
      const pipe = await pipeline('feature-extraction', config.embeddingModel, {
        session_options: { numThreads: 2 } 
      });
      return pipe(text, { pooling: 'mean', normalize: true });
  };

  const searcher = new HybridSearch(embedder, cache, config);
  console.info(`\n--- Searching for: "${query}" ---`);
  const { results } = await searcher.search(query, 5);

  results.forEach((r, i) => {
    console.info(`[${i+1}] ${r.file}:${r.startLine}-${r.endLine} (Score: ${r.score.toFixed(4)})`);
    console.info(`    Content: ${r.content.substring(0, 200).replace(/\n/g, ' ')}...`);
  });
}

const query = process.argv[2] || 'database implementation';
runSearch(query).catch(err => console.error(err));
