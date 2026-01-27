
import { loadConfig } from './lib/config.js';
import { EmbeddingsCache } from './lib/cache.js';
import { HybridSearch } from './features/hybrid-search.js';
import { pipeline, env } from '@xenova/transformers';

// Force same thread config as server
env.backends.onnx.numThreads = 2;
env.backends.onnx.wasm.numThreads = 2;

async function testSearch() {
  console.info('--- Starting Search Test ---');
  
  // 1. Load Config
  const config = await loadConfig(process.cwd());
  config.verbose = true;

  // 2. Load Cache (this reads the data the server just built)
  const cache = new EmbeddingsCache(config);
  console.info(`[Test] Loading cache from: ${config.cacheDirectory}`);
  await cache.load();
  console.info(`Cache loaded with ${cache.getVectorStore().length} chunks.`);

  // 3. Initialize Embedder (Lazy)
  const embedder = async (text) => {
      const pipe = await pipeline('feature-extraction', config.embeddingModel, {
        session_options: { numThreads: 2 } 
      });
      return pipe(text, { pooling: 'mean', normalize: true });
  };

  // 4. Perform Search
  const searcher = new HybridSearch(embedder, cache, config);
  console.info('Searching for "how are worker threads initialized with memory limits"...');
  
  const { results, message } = await searcher.search('how are worker threads initialized with memory limits');

  if (message) {
      console.info(`\n[Server Message]: ${message}`);
  }
  
  // 5. Output Results
  console.info(`\n--- Top 3 Results (Total: ${results.length}) ---`);
  results.slice(0, 3).forEach((r, i) => {
    console.info(`[${i+1}] ${r.file} (Score: ${r.score.toFixed(4)})`);
    console.info(`    Snippet: ${r.content.substring(0, 100).replace(/\n/g, ' ')}...`);
  });
}

testSearch().catch(err => console.error(err));
