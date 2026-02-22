# Heuristic MCP Advanced Guide

This document contains the detailed and advanced reference.
For quick install and basics, see [`../README.md`](../README.md).

---

## Key Features

- Zero-touch setup: postinstall auto-registers the MCP server with supported IDEs when possible.
- Smart indexing: detects project type and applies smart ignore patterns on top of your excludes.
- Semantic search: find code by meaning, not just keywords.
- Find similar code: locate near-duplicate or related patterns from a snippet.
- Package version lookup: check latest versions from npm, PyPI, crates.io, Maven, and more.
- Workspace switching: change workspace at runtime without restarting the server.
- Recency ranking and call-graph boosting: surfaces fresh and related code.
- Optional ANN index: faster candidate retrieval for large codebases.
- Optional binary vector store: mmap-friendly cache format for large repos.
- Flexible embedding dimensions: MRL-compatible dimension reduction (64-768d) for speed/quality tradeoffs.

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
heuristic-mcp --start
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

### Start/Stop

```bash
heuristic-mcp --start
heuristic-mcp --start antigravity
heuristic-mcp --start codex
heuristic-mcp --start cursor
heuristic-mcp --start vscode
heuristic-mcp --start windsurf
heuristic-mcp --start warp
heuristic-mcp --start "Claude Desktop"
heuristic-mcp --stop
```

`--start` registers (if needed) and enables the MCP server entry. `--stop` disables it so the IDE won't immediately respawn it. Restart/reload the IDE after `--start` to launch.

Warp note: this package now targets `~/.warp/mcp_settings.json` (and `%APPDATA%\\Warp\\mcp_settings.json` on Windows when present). If no local Warp MCP config is writable yet, use Warp MCP settings/UI once to initialize it, then re-run `--start warp`.

### Clear Cache

```bash
heuristic-mcp --clear-cache
```

Clears the cache for the current working directory (or `--workspace` if provided) and removes stale cache directories without metadata.

---

## Configuration (`config.jsonc`)

Configuration is loaded from your workspace root when the server runs with `--workspace`. If not provided by the IDE, the server auto-detects workspace via environment variables and current working directory. In server mode, it falls back to the package `config.jsonc` (or `config.json`) and then your current working directory.

Example `config.jsonc`:

```json
{
  "excludePatterns": ["**/legacy-code/**", "**/*.test.ts"],
  "fileNames": ["Dockerfile", ".env.example", "Makefile"],
  "indexing": {
    "smartIndexing": true
  },
  "worker": {
    "workerThreads": 0
  },
  "embedding": {
    "embeddingModel": "jinaai/jina-embeddings-v2-base-code",
    "embeddingBatchSize": null,
    "embeddingProcessNumThreads": 8
  },
  "search": {
    "recencyBoost": 0.1,
    "recencyDecayDays": 30
  },
  "callGraph": {
    "callGraphEnabled": true,
    "callGraphBoost": 0.15
  },
  "ann": {
    "annEnabled": true
  },
  "vectorStore": {
    "vectorStoreFormat": "binary",
    "vectorStoreContentMode": "external",
    "vectorStoreLoadMode": "disk",
    "contentCacheEntries": 256,
    "vectorCacheEntries": 64
  },
  "memoryCleanup": {
    "clearCacheAfterIndex": true
  }
}
```

Preferred style is namespaced keys (shown above). Legacy top-level keys are still supported for backward compatibility.

### Embedding Model & Dimension Options

**Default model:** `jinaai/jina-embeddings-v2-base-code` (768 dimensions)

> **Important:** The default Jina model was **not** trained with Matryoshka Representation Learning (MRL). Dimension reduction (`embeddingDimension`) will significantly degrade search quality with this model. Only use dimension reduction with MRL-trained models.

For faster search with smaller embeddings, switch to an MRL-compatible model:

```json
{
  "embedding": {
    "embeddingModel": "nomic-ai/nomic-embed-text-v1.5",
    "embeddingDimension": 128
  }
}
```

**MRL-compatible models:**

- `nomic-ai/nomic-embed-text-v1.5` — recommended for 128d/256d
- Other models explicitly trained with Matryoshka loss

**embeddingDimension values:** `64 | 128 | 256 | 512 | 768 | null` (null = full dimensions)

Cache location:

- By default, the cache is stored in a global OS cache directory under `heuristic-mcp/<hash>`.
- You can override with `cacheDirectory` in your config file.

### Environment Variables

Selected overrides (prefix `SMART_CODING_`):

Environment overrides target runtime keys and are synced back into namespaces by `lib/config.js`.

- `SMART_CODING_VERBOSE=true|false` — enable detailed logging.
- `SMART_CODING_WORKER_THREADS=auto|N` — worker thread count.
- `SMART_CODING_BATCH_SIZE=100` — files per indexing batch.
- `SMART_CODING_CHUNK_SIZE=25` — lines per chunk.
- `SMART_CODING_MAX_RESULTS=5` — max search results.
- `SMART_CODING_EMBEDDING_BATCH_SIZE=64` — embedding batch size (1–256, overrides auto).
- `SMART_CODING_EMBEDDING_THREADS=8` — ONNX threads for the embedding child process.
- `SMART_CODING_RECENCY_BOOST=0.1` — boost for recently edited files.
- `SMART_CODING_RECENCY_DECAY_DAYS=30` — days until recency boost decays to 0.
- `SMART_CODING_ANN_ENABLED=true|false` — enable ANN index.
- `SMART_CODING_ANN_EF_SEARCH=64` — ANN search quality/speed tradeoff.
- `SMART_CODING_VECTOR_STORE_FORMAT=json|binary|sqlite` — on-disk vector store format.
- `SMART_CODING_VECTOR_STORE_CONTENT_MODE=external|inline` — where content is stored for binary format.
- `SMART_CODING_VECTOR_STORE_LOAD_MODE=memory|disk` — vector loading strategy.
- `SMART_CODING_CONTENT_CACHE_ENTRIES=256` — LRU entries for decoded content.
- `SMART_CODING_VECTOR_CACHE_ENTRIES=64` — LRU entries for vectors (disk mode).
- `SMART_CODING_CLEAR_CACHE_AFTER_INDEX=true|false` — drop in-memory vectors after indexing.
- `SMART_CODING_UNLOAD_MODEL_AFTER_INDEX=true|false` — unload embedding model after indexing to free RAM (~500MB-1GB).
- `SMART_CODING_EXPLICIT_GC=true|false` — opt-in to explicit GC (requires `--expose-gc`).
- `SMART_CODING_INCREMENTAL_GC_THRESHOLD_MB=2048` — RSS threshold for running incremental GC after watcher updates (requires explicit GC).
- `SMART_CODING_EMBEDDING_DIMENSION=64|128|256|512|768` — MRL dimension reduction (only for MRL-trained models).

See `lib/config.js` for the full list.

### Binary Vector Store

Set `vectorStore.vectorStoreFormat` to `binary` to use the on-disk binary cache. This keeps vectors and content out of JS heap
and reads on demand. Recommended for large repos.

- `vectorStore.vectorStoreContentMode=external` keeps content in the binary file and only loads for top-N results.
- `vectorStore.contentCacheEntries` controls the small in-memory LRU for decoded content strings.
- `vectorStore.vectorStoreLoadMode=disk` streams vectors from disk to reduce memory usage.
- `vectorStore.vectorCacheEntries` controls the small in-memory LRU for vectors when using disk mode.
- `memoryCleanup.clearCacheAfterIndex=true` drops in-memory vectors after indexing and reloads lazily on next query.
- `memoryCleanup.unloadModelAfterIndex=true` (default) unloads the embedding model after indexing to free ~500MB-1GB of RAM; the model will reload on the next search query.
- Note: `ann.annEnabled=true` with `vectorStore.vectorStoreLoadMode=disk` can increase disk reads during ANN rebuilds on large indexes.

### SQLite Vector Store

Set `vectorStore.vectorStoreFormat` to `sqlite` to use SQLite for persistence. This provides:

- ACID transactions for reliable writes
- Simpler concurrent access
- Standard database format for inspection

```json
{
  "vectorStore": {
    "vectorStoreFormat": "sqlite"
  }
}
```

The vectors and content are stored in `vectors.sqlite` in your cache directory. You can inspect it with any SQLite browser.
`vectorStore.vectorStoreContentMode` and `vectorStore.vectorStoreLoadMode` are respected for SQLite (use `vectorStore.vectorStoreLoadMode=disk` to avoid loading vectors into memory).

**Tradeoffs vs Binary:**

- Slightly higher read overhead (SQL queries vs direct memory access)
- Better write reliability (transactions)
- Easier debugging (standard SQLite file)

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

Note: On small repos, disk mode may be slightly slower and show noisy RSS deltas; benefits are clearer on large indexes with a small `vectorStore.vectorCacheEntries`.

---

## MCP Tools Reference

### `a_semantic_search`

Find code by meaning. Ideal for natural language queries like "authentication logic" or "database queries".

### `b_index_codebase`

Manually trigger a full reindex. Useful after large code changes.

### `c_clear_cache`

Clear the embeddings cache and force reindex.

### `d_ann_config`

Configure the ANN (Approximate Nearest Neighbor) index. Actions: `stats`, `set_ef_search`, `rebuild`.

### `d_find_similar_code`

Find similar code patterns given a snippet. Useful for finding duplicates or refactoring opportunities.

### `e_check_package_version`

Fetch the latest version of a package from its official registry.

**Supported registries:**

- **npm** (default): `lodash`, `@types/node`
- **PyPI**: `pip:requests`, `pypi:django`
- **crates.io**: `cargo:serde`, `rust:tokio`
- **Maven**: `maven:org.springframework:spring-core`
- **Go**: `go:github.com/gin-gonic/gin`
- **RubyGems**: `gem:rails`
- **NuGet**: `nuget:Newtonsoft.Json`
- **Packagist**: `composer:laravel/framework`
- **Hex**: `hex:phoenix`
- **pub.dev**: `pub:flutter`
- **Homebrew**: `brew:node`
- **Conda**: `conda:numpy`

### `f_set_workspace`

Change the workspace directory at runtime. Updates search directory, cache location, and optionally triggers reindex.

The server also attempts this automatically before each tool call when it detects a new workspace path from environment variables (for example `CODEX_WORKSPACE`, `CODEX_PROJECT_ROOT`, `WORKSPACE_FOLDER`).

**Parameters:**

- `workspacePath` (required): Absolute path to the new workspace
- `reindex` (optional, default: `true`): Whether to trigger a full reindex

---

## Release & CI

Publishing is handled by `publish.sh` (Bash) or `publish.ps1` (PowerShell):

```bash
./publish.sh          # Interactive: prompts for fix/feat/chore/major
./publish.sh patch    # Non-interactive: patch bump
./publish.ps1 -Bump minor -ReleaseType feat
```

The scripts:
1. Verify clean git tree and npm auth
2. Bump version, preflight-check the tarball
3. Commit, create annotated git tag `v<version>`
4. Publish to npm, push commit + tag

On tag push, `.github/workflows/release.yml` automatically:
- Creates a **GitHub Release** with auto-generated release notes
- Publishes the package to **GitHub Packages** (`npm.pkg.github.com`)

---

## Troubleshooting

**Server isn't starting**

1. Run `heuristic-mcp --status` to check config and cache status.
2. Run `heuristic-mcp --logs` to see startup errors.

**Native ONNX backend unavailable (falls back to WASM)**

If you see log lines like:

```
Native ONNX backend unavailable: The operating system cannot run %1.
...onnxruntime_binding.node. Falling back to WASM.
```

The server will automatically disable workers and force `embedding.embeddingProcessPerBatch` to reduce memory spikes, but you
should fix the native binding to restore stable memory usage:

- Ensure you are running **64-bit Node.js** (`node -p "process.arch"` should be `x64`).
- Install **Microsoft Visual C++ 2015–2022 Redistributable (x64)**.
- Reinstall dependencies (clears locked native binaries):

```bash
Remove-Item -Recurse -Force node_modules\\onnxruntime-node, node_modules\\.onnxruntime-node-* -ErrorAction SilentlyContinue
npm install
```

If you see a warning about **version mismatch** (e.g. "onnxruntime-node 1.23.x incompatible with transformers.js
expectation 1.14.x"), install the matching version:

```bash
npm install onnxruntime-node@1.14.0
```

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

- The IDE will auto-restart the server if it's still enabled in its config. `--stop` now disables the server entry for Antigravity, Cursor (including `~/.cursor/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`), Warp (`~/.warp/mcp_settings.json` and `%APPDATA%\\Warp\\mcp_settings.json` when present), Claude Desktop, and VS Code (when using common MCP settings keys). Restart the IDE after `--start` to re-enable.

---

## Contributing & Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full module and data-flow reference.

License: MIT
