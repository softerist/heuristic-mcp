# Heuristic MCP Server

An enhanced MCP server for your codebase. It provides intelligent semantic search, find-similar-code, recency-aware ranking, call-graph proximity boosts, and smart chunking. Optimized for Antigravity, Cursor, Claude Desktop, and VS Code.

---

## Key Features

- Zero-touch setup: postinstall auto-registers the MCP server with supported IDEs when possible.
- Smart indexing: detects project type and applies smart ignore patterns on top of your excludes.
- Semantic search: find code by meaning, not just keywords.
- Find similar code: locate near-duplicate or related patterns from a snippet.
- Recency ranking and call-graph boosting: surfaces fresh and related code.
- Optional ANN index: faster candidate retrieval for large codebases.
- Optional binary vector store: mmap-friendly cache format for large repos.

---

## Installation

Install globally (recommended):

```bash
npm install -g @softerist/heuristic-mcp
```

What happens during install:

- Registration runs automatically (`scripts/postinstall.js`).
- Model pre-download is attempted (`scripts/download-model.js`). If offline, it will be skipped and downloaded on first run.

If auto-registration did not update your IDE config, run:

```bash
heuristic-mcp --register
```

---

## CLI Commands

The `heuristic-mcp` binary manages the server lifecycle.

### Status

```bash
heuristic-mcp --status
```

Shows server PID(s) and cache stats.

### Logs

```bash
heuristic-mcp --logs
```

Tails the server log for the current workspace (defaults to last 200 lines and follows).

Optional flags:

```bash
heuristic-mcp --logs --tail 100
heuristic-mcp --logs --no-follow
```

### Version

```bash
heuristic-mcp --version
```

### Register (manual)

```bash
heuristic-mcp --register
heuristic-mcp --register antigravity
heuristic-mcp --register cursor
heuristic-mcp --register "Claude Desktop"
```

### Start/Stop

```bash
heuristic-mcp --start
heuristic-mcp --stop
```

`--stop` also disables the MCP server entry in supported IDE configs so the IDE won't immediately respawn it. `--start` re-enables it (restart/reload the IDE to launch).

### Clear Cache

```bash
heuristic-mcp --clear-cache
```

Clears the cache for the current working directory (or `--workspace` if provided) and removes stale cache directories without metadata.

---

## Configuration (`config.json`)

Configuration is loaded from your workspace root when the server runs with `--workspace` (this is how IDEs launch it). In server mode, it falls back to the package `config.json` and then your current working directory.

Example `config.json`:

```json
{
  "excludePatterns": ["**/legacy-code/**", "**/*.test.ts"],
  "fileNames": ["Dockerfile", ".env.example", "Makefile"],
  "smartIndexing": true,
  "embeddingModel": "jinaai/jina-embeddings-v2-base-code",
  "workerThreads": 0,
  "enableExplicitGc": false,
  "recencyBoost": 0.1,
  "recencyDecayDays": 30,
  "callGraphEnabled": true,
  "callGraphBoost": 0.15,
  "annEnabled": true,
  "vectorStoreFormat": "binary",
  "vectorStoreContentMode": "external",
  "vectorStoreLoadMode": "disk",
  "contentCacheEntries": 256,
  "vectorCacheEntries": 64,
  "clearCacheAfterIndex": true
}
```

Cache location:

- By default, the cache is stored in a global OS cache directory under `heuristic-mcp/<hash>`.
- You can override with `cacheDirectory` in `config.json`.

### Environment Variables

Selected overrides (prefix `SMART_CODING_`):

- `SMART_CODING_VERBOSE=true|false` — enable detailed logging.
- `SMART_CODING_WORKER_THREADS=auto|0|N` — worker thread count (`0` disables workers).
- `SMART_CODING_BATCH_SIZE=100` — files per indexing batch.
- `SMART_CODING_CHUNK_SIZE=25` — lines per chunk.
- `SMART_CODING_MAX_RESULTS=5` — max search results.
- `SMART_CODING_RECENCY_BOOST=0.1` — boost for recently edited files.
- `SMART_CODING_RECENCY_DECAY_DAYS=30` — days until recency boost decays to 0.
- `SMART_CODING_ANN_ENABLED=true|false` — enable ANN index.
- `SMART_CODING_ANN_EF_SEARCH=64` — ANN search quality/speed tradeoff.
- `SMART_CODING_VECTOR_STORE_FORMAT=json|binary` — on-disk vector store format.
- `SMART_CODING_VECTOR_STORE_CONTENT_MODE=external|inline` — where content is stored for binary format.
- `SMART_CODING_VECTOR_STORE_LOAD_MODE=memory|disk` — vector loading strategy.
- `SMART_CODING_CONTENT_CACHE_ENTRIES=256` — LRU entries for decoded content.
- `SMART_CODING_VECTOR_CACHE_ENTRIES=64` — LRU entries for vectors (disk mode).
- `SMART_CODING_CLEAR_CACHE_AFTER_INDEX=true|false` — drop in-memory vectors after indexing.
- `SMART_CODING_EXPLICIT_GC=true|false` — opt-in to explicit GC (requires `--expose-gc`).
- `SMART_CODING_INCREMENTAL_GC_THRESHOLD_MB=2048` — RSS threshold for running incremental GC after watcher updates (requires explicit GC).

See `lib/config.js` for the full list.

### Binary Vector Store

Set `vectorStoreFormat` to `binary` to use the on-disk binary cache. This keeps vectors and content out of JS heap
and reads on demand. Recommended for large repos.

- `vectorStoreContentMode=external` keeps content in the binary file and only loads for top-N results.
- `contentCacheEntries` controls the small in-memory LRU for decoded content strings.
- `vectorStoreLoadMode=disk` streams vectors from disk to reduce memory usage.
- `vectorCacheEntries` controls the small in-memory LRU for vectors when using disk mode.
- `clearCacheAfterIndex=true` drops in-memory vectors after indexing and reloads lazily on next query.
- Note: `annEnabled=true` with `vectorStoreLoadMode=disk` can increase disk reads during ANN rebuilds on large indexes.

### Benchmarking Search

Use the built-in script to compare memory vs latency tradeoffs:

```bash
node tools/scripts/benchmark-search.js --query "database connection" --runs 10
```

Compare modes quickly:

```bash
SMART_CODING_VECTOR_STORE_LOAD_MODE=memory node tools/scripts/benchmark-search.js --runs 10
SMART_CODING_VECTOR_STORE_LOAD_MODE=disk node tools/scripts/benchmark-search.js --runs 10
SMART_CODING_VECTOR_STORE_FORMAT=binary SMART_CODING_VECTOR_STORE_LOAD_MODE=disk node tools/scripts/benchmark-search.js --runs 10
```

Note: On small repos, disk mode may be slightly slower and show noisy RSS deltas; benefits are clearer on large indexes with a small `vectorCacheEntries`.

---

## Troubleshooting

**Server isn't starting**

1. Run `heuristic-mcp --status` to check config and cache status.
2. Run `heuristic-mcp --logs` to see startup errors.

**Search returns no results**

- Check `heuristic-mcp --status` for indexing progress.
- If indexing shows zero files, review `excludePatterns` and `fileExtensions`.

**Model download fails**

- The install step tries to pre-download the model, but it can be skipped offline.
- The server will download on first run; ensure network access at least once.

**Clear cache**

- Use the MCP tool `c_clear_cache`, run `heuristic-mcp --clear-cache`, or delete the cache directory. For local dev, run `npm run clean`.

**Inspect cache**

```bash
node tools/scripts/cache-stats.js --workspace <path>
```

**Stop doesn't stick**

- The IDE will auto-restart the server if it's still enabled in its config. `--stop` now disables the server entry for Antigravity, Cursor, Claude Desktop, and VS Code (when using common MCP settings keys). Restart the IDE after `--start` to re-enable.

---

## Contributing

See `CONTRIBUTING.md` for guidelines.

License: MIT
