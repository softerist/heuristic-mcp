import { loadConfig } from '../../lib/config.js';
import { EmbeddingsCache } from '../../lib/cache.js';
import { HybridSearch } from '../../features/hybrid-search.js';
import { pipeline, env } from '@xenova/transformers';

// Force same thread config as server
env.backends.onnx.numThreads = 2;
env.backends.onnx.wasm.numThreads = 2;

function parseArgs(argv) {
  const args = argv.slice(2);
  let query = null;
  let runs = 5;
  let maxResults = 5;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--query' && args[i + 1]) {
      query = args[i + 1];
      i += 1;
    } else if (arg === '--runs' && args[i + 1]) {
      runs = parseInt(args[i + 1], 10);
      i += 1;
    } else if (arg === '--max-results' && args[i + 1]) {
      maxResults = parseInt(args[i + 1], 10);
      i += 1;
    } else if (!arg.startsWith('-') && !query) {
      query = arg;
    }
  }

  return {
    query: query || 'database implementation',
    runs: Number.isFinite(runs) && runs > 0 ? runs : 5,
    maxResults: Number.isFinite(maxResults) && maxResults > 0 ? maxResults : 5,
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const { query, runs, maxResults } = parseArgs(process.argv);
  const config = await loadConfig(process.cwd());
  const cache = new EmbeddingsCache(config);
  await cache.load();

  const embedder = async (text) => {
    if (!embedder._pipeline) {
      embedder._pipeline = await pipeline('feature-extraction', config.embeddingModel, {
        session_options: { numThreads: 2 },
      });
    }
    return embedder._pipeline(text, { pooling: 'mean', normalize: true });
  };

  const searcher = new HybridSearch(embedder, cache, config);

  console.info(`Benchmark query: "${query}"`);
  console.info(`Runs: ${runs}, maxResults: ${maxResults}`);
  console.info(
    `Vector load mode: ${config.vectorStoreLoadMode}, format: ${config.vectorStoreFormat}`
  );

  // Warm-up
  await searcher.search(query, maxResults);

  const durations = [];
  const memBefore = process.memoryUsage().rss;

  for (let i = 0; i < runs; i += 1) {
    const start = process.hrtime.bigint();
    await searcher.search(query, maxResults);
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;
    durations.push(ms);
    console.info(`Run ${i + 1}: ${ms.toFixed(2)}ms`);
  }

  const memAfter = process.memoryUsage().rss;
  const sorted = [...durations].sort((a, b) => a - b);
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const p95 = percentile(sorted, 95);

  console.info(`Avg: ${avg.toFixed(2)}ms, p95: ${p95.toFixed(2)}ms`);
  console.info(`RSS change: ${((memAfter - memBefore) / 1024 / 1024).toFixed(1)}MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
