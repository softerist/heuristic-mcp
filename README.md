# Heuristic MCP Server

An enhanced MCP server for your codebase. It provides intelligent semantic search, find-similar-code, recency-aware ranking, call-graph proximity boosts, and smart chunking. Optimized for Antigravity, Cursor, and Claude Desktop.

---

## Key Features

- Zero-touch setup: postinstall auto-registers the MCP server with supported IDEs when possible.
- Smart indexing: detects project type and applies smart ignore patterns on top of your excludes.
- Semantic search: find code by meaning, not just keywords.
- Find similar code: locate near-duplicate or related patterns from a snippet.
- Recency ranking and call-graph boosting: surfaces fresh and related code.
- Optional ANN index: faster candidate retrieval for large codebases.

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
  "workerThreads": "auto",
  "recencyBoost": 0.1,
  "recencyDecayDays": 30,
  "callGraphEnabled": true,
  "callGraphBoost": 0.15,
  "annEnabled": true
}
```

Cache location:

- By default, the cache is stored in a global OS cache directory under `heuristic-mcp/<hash>`.
- You can override with `cacheDirectory` in `config.json`.

### Environment Variables

Selected overrides (prefix `SMART_CODING_`):

- `SMART_CODING_VERBOSE=true|false`
- `SMART_CODING_WORKER_THREADS=auto|N`
- `SMART_CODING_BATCH_SIZE=100`
- `SMART_CODING_CHUNK_SIZE=25`
- `SMART_CODING_MAX_RESULTS=5`
- `SMART_CODING_RECENCY_BOOST=0.1`
- `SMART_CODING_RECENCY_DECAY_DAYS=30`
- `SMART_CODING_ANN_ENABLED=true|false`
- `SMART_CODING_ANN_EF_SEARCH=64`

See `lib/config.js` for the full list.

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

---

## Contributing

See `CONTRIBUTING.md` for guidelines.

License: MIT
