import { loadConfig } from '../../lib/config.js';
import { EmbeddingsCache } from '../../lib/cache.js';
import { HybridSearch } from '../../features/hybrid-search.js';
import { pipeline, env } from '@huggingface/transformers';

// Force same thread config as server
env.backends.onnx.numThreads = 2;
env.backends.onnx.wasm.numThreads = 2;

async function runSearch(query, maxResults = 5, { verbose = false } = {}) {
  const originalInfo = console.info;
  const originalWarn = console.warn;
  if (!verbose) {
    console.info = (...args) => {
      const text = args.map(String).join(' ');
      if (
        text.startsWith('[Detector]') ||
        text.startsWith('[Config]') ||
        text.startsWith('[Cache]') ||
        text.startsWith('[Search]') ||
        text.startsWith('[CallGraph]')
      ) {
        return;
      }
      originalInfo(...args);
    };
    console.warn = (...args) => {
      const text = args.map(String).join(' ');
      if (text.startsWith('dtype not specified')) return;
      originalWarn(...args);
    };
  }

  const config = await loadConfig(process.cwd());
  const cache = new EmbeddingsCache(config);
  await cache.load();

  try {
    const embedder = async (text) => {
      const pipe = await pipeline('feature-extraction', config.embeddingModel, {
        session_options: { numThreads: 2 },
      });
      return pipe(text, { pooling: 'mean', normalize: true });
    };

    const searcher = new HybridSearch(embedder, cache, config);
    console.info(`\n--- Searching for: "${query}" ---`);
    const { results } = await searcher.search(query, maxResults);

    results.forEach((r, i) => {
      console.info(
        `[${i + 1}] ${r.file}:${r.startLine}-${r.endLine} (Score: ${r.score.toFixed(4)})`
      );
      console.info(`    Content: ${r.content.substring(0, 200).replace(/\n/g, ' ')}...`);
    });
  } finally {
    await cache.close().catch(() => {});
    console.info = originalInfo;
    console.warn = originalWarn;
  }
}

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const filteredArgs = args.filter((arg) => arg !== '--verbose');
const query = filteredArgs[0] || 'database implementation';
const maxResultsArg = filteredArgs[1];
const maxResults = maxResultsArg ? Number.parseInt(maxResultsArg, 10) : 5;
const safeMaxResults = Number.isFinite(maxResults) && maxResults > 0 ? maxResults : 5;
runSearch(query, safeMaxResults, { verbose }).catch((err) => console.error(err));
