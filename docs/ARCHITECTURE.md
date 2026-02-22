# Architecture Overview

This document outlines the modular architecture of Heuristic MCP.

## Directory Structure

```
heuristic-mcp/
├── index.js                    # Main entry point, MCP server setup
├── package.json                # Package configuration
├── config.jsonc                # Sample configuration
├── mcp_config.json             # MCP server metadata
├── LICENSE                     # MIT License
├── README.md                   # Project documentation
├── .gitignore                  # Git ignore rules
├── .npmignore                  # npm publish ignore rules
├── publish.sh                  # Release script (Bash)
├── publish.ps1                 # Release script (PowerShell)
│
├── .github/
│   └── workflows/
│       └── release.yml         # Auto-create GitHub Release + GitHub Packages on tag push
│
├── docs/
│   └── ARCHITECTURE.md         # This file
│
├── lib/                        # Core libraries
│   ├── cache-ops.js            # CLI-facing cache clear function
│   ├── cache-utils.js          # Stale cache detection/cleanup
│   ├── cache.js                # Embeddings cache management + ANN index
│   ├── call-graph.js           # Symbol extraction and call graph helpers
│   ├── cli.js                  # CLI argument parsing helpers
│   ├── config.js               # Configuration loader and env overrides
│   ├── constants.js            # Shared constants (env vars, MIME types, patterns)
│   ├── embed-query-process.js  # Query embedding child-process pool
│   ├── embedding-process.js    # Child-process embedder runner (isolation)
│   ├── embedding-worker.js     # Worker-thread embedder runner
│   ├── ignore-patterns.js      # Smart ignore patterns by project type
│   ├── json-worker.js          # Off-thread JSON parsing
│   ├── json-writer.js          # Streaming JSON writer
│   ├── logging.js              # Log file + stderr redirection helpers
│   ├── memory-logger.js        # RSS/heap memory logging utilities
│   ├── onnx-backend.js         # Native ONNX runtime detection and configuration
│   ├── path-utils.js           # Cross-platform path normalization
│   ├── project-detector.js     # Language/project detection
│   ├── server-lifecycle.js     # PID files, workspace locks, signal handlers
│   ├── settings-editor.js      # JSON/JSONC/TOML IDE config file editing
│   ├── slice-normalize.js      # Vector slicing/normalization helpers
│   ├── tokenizer.js            # Token estimation and limits
│   ├── utils.js                # Shared utilities (chunking, similarity)
│   ├── vector-store-binary.js  # Binary on-disk vector store (mmap-friendly)
│   ├── vector-store-sqlite.js  # SQLite-backed vector store
│   ├── workspace-cache-key.js  # Deterministic workspace → cache path hashing
│   └── workspace-env.js        # Workspace path discovery from environment variables
│
├── features/                   # Pluggable features (MCP tools + lifecycle)
│   ├── hybrid-search.js        # Semantic + exact match search
│   ├── index-codebase.js       # Code indexing with checkpointing and graceful stop
│   ├── clear-cache.js          # Cache management feature
│   ├── find-similar-code.js    # Similarity search by code snippet
│   ├── ann-config.js           # ANN configuration tool
│   ├── package-version.js      # Package registry version lookup
│   ├── resources.js            # MCP resources listing/reading (file URIs)
│   ├── set-workspace.js        # Runtime workspace switching
│   ├── lifecycle.js            # CLI lifecycle (--start, --stop, --status, --logs)
│   └── register.js             # IDE auto-registration logic
│
├── scripts/                    # Published runtime scripts (shipped in npm package)
│   ├── postinstall.js          # Auto-register on install
│   ├── download-model.js       # Optional model pre-download
│   ├── mcp-launcher.js         # MCP server launcher entry
│   └── clear-cache.js          # Cache management utility
│
├── tools/                      # Developer-only helpers (not published)
│   └── scripts/
│       ├── benchmark-search.js # Search/memory benchmarking
│       ├── cache-stats.js      # Cache inspection utility
│       ├── manual-search.js    # Manual semantic search testing
│       └── stress-primary-mcp.js # MCP server stress testing
│
└── test/                       # Vitest test suite (70+ test files)
    ├── helpers.js              # Shared test fixtures and utilities
    └── *.test.js               # Unit and integration tests
```

## Module Responsibilities

### index.js

- MCP server initialization via `@modelcontextprotocol/sdk`
- Feature registry and orchestration
- Tool request routing
- Global state management (embedder, cache, config)

### lib/config.js

- Loads and validates configuration from `config.jsonc` or `config.json`
- Provides default configuration values
- Resolves file paths and cache location
- Applies `SMART_CODING_*` environment variable overrides
- Supports namespaced config sections (e.g. `embedding`, `worker`, `vectorStore`, `memoryCleanup`) with backward-compatible top-level keys

### lib/cache.js

- **EmbeddingsCache** class
- Manages persistence of embedding vectors
- File hash tracking for change detection
- Load/save operations for disk cache
- Optional ANN (HNSW) index build/load/save for fast search
- Supports JSON, binary, and SQLite vector store formats
- Supports memory or disk vector load modes for lower RSS

### lib/cache-ops.js

- Standalone `clearCache()` function used by the CLI (`--clear-cache`)
- Loads config for a given workspace and removes its cache directory

### lib/cache-utils.js

- Stale cache detection/cleanup for caches without metadata
- Uses `progress.json` recency to avoid deleting active indexes

### lib/onnx-backend.js

- Detects native `onnxruntime-node` availability and version compatibility
- Configures execution providers (CPU), thread counts, and WASM fallback
- Patches `InferenceSession.create` to inject thread options

### lib/embedding-process.js

- Child-process embedding path for isolation
- Used to recover from hung or crashing workers

### lib/embedding-worker.js

- Worker-thread embedding path for concurrency
- Cooperates with worker circuit breaker logic in indexing

### lib/embed-query-process.js

- Dedicated child-process pool for query embedding
- Ensures search queries don't block or interfere with indexing workers

### lib/server-lifecycle.js

- PID file management (write, read, cleanup on exit)
- Workspace lock acquisition/release with retry and stale lock removal
- Signal handler registration (SIGINT, SIGTERM)
- Cross-instance coordination: stop other running heuristic-mcp servers

### lib/settings-editor.js

- Comment-preserving JSON/JSONC parser and editor
- TOML section parser and editor
- Upserts MCP server entries into IDE config files
- Format-aware: respects existing indentation and newline style

### lib/workspace-cache-key.js

- Generates deterministic MD5-based cache directory names from workspace paths
- Handles Windows case-insensitive path normalization
- Supports legacy, drive-letter-compat, and canonical key formats for migration

### lib/workspace-env.js

- Discovers workspace path from environment variables (`CODEX_WORKSPACE`, `WORKSPACE_FOLDER`, etc.)
- Supports dynamic prefix-based discovery for new IDE integrations
- Scores and prioritizes candidate env vars by specificity

### lib/path-utils.js

- Cross-platform path normalization (forward slashes, lowercase on Windows)
- `isPathInside()` containment check for workspace boundary enforcement

### lib/memory-logger.js

- `logMemory()` — logs RSS and heap usage
- `startMemoryLogger()` — periodic memory logging on an interval

### lib/ignore-patterns.js

- Smart ignore patterns derived from detected project type

### lib/json-worker.js / lib/json-writer.js

- Streaming JSON writer and off-thread parsing helpers

### lib/logging.js

- Log file path and directory helpers
- Console redirection for MCP stdout safety

### lib/cli.js

- Parses CLI flags for server and lifecycle commands

### lib/vector-store-binary.js

- Binary vector store with header + record table + content blocks
- Mmap-friendly layout, content loaded on demand

### lib/vector-store-sqlite.js

- SQLite vector store with transactional writes
- Standard DB format for inspection and debugging

### lib/utils.js

- **dotSimilarity()** — Vector similarity calculation
- **hashContent()** — MD5 hashing for change detection
- **smartChunk()** — Language-aware code chunking

### lib/call-graph.js

- Extracts definitions and calls
- Builds a lightweight call graph for proximity boosting

### features/hybrid-search.js

- **HybridSearch** class
- Combines semantic and exact matching
- Recency and call-graph proximity boosting
- MCP tool: `a_semantic_search`

### features/index-codebase.js

- **CodebaseIndexer** class
- File discovery via glob patterns
- Incremental indexing with checkpoint-save support
- Graceful stop (`requestGracefulStop`) for interruptible indexing
- Optional file watcher for real-time updates
- Progress tracking via `progress.json`
- MCP tool: `b_index_codebase`

### features/clear-cache.js

- **CacheClearer** class
- Clears vector store and cache directory
- MCP tool: `c_clear_cache`

### features/find-similar-code.js

- **FindSimilarCode** class
- Finds semantically similar code snippets
- MCP tool: `d_find_similar_code`

### features/ann-config.js

- **AnnConfigTool** class
- Runtime ANN tuning and stats
- MCP tool: `d_ann_config`

### features/set-workspace.js

- Runtime workspace switching
- Updates search root and cache root, with optional reindex

### features/package-version.js

- Registry-aware package version lookup (npm, PyPI, crates.io, Maven, Go, Gems, NuGet, Packagist, Hex, pub.dev, Homebrew, Conda)
- MCP tool: `e_check_package_version`

### features/resources.js

- MCP resources protocol implementation
- Lists workspace files as `file://` URIs with MIME types
- Reads file content within workspace boundary

### features/lifecycle.js

- CLI entrypoint for `--start`, `--stop`, `--status`, `--logs`, `--clear-cache`, `--version`
- IDE config discovery: Antigravity, Cursor, VS Code, Windsurf, Warp, Claude Desktop, Codex
- Server status reporting: PID, workspace, cache stats, indexing progress, binary store telemetry
- Calls `settings-editor.js` and `server-lifecycle.js` for config editing and process management

### features/register.js

- Auto-registration during `postinstall`
- Detects installed IDEs and writes/updates their MCP config files

## CI/CD & Release

### publish.sh / publish.ps1

Cross-platform release scripts that:
1. Prompt for release intent (fix/feat/chore/major/prerelease) or accept CLI args
2. Verify clean git tree and npm auth
3. Bump version via `npm version --no-git-tag-version`
4. Preflight check: validate `npm pack` includes required runtime files
5. Commit, create annotated git tag `v<version>`
6. Publish to npm
7. Push commit + tag (`git push --follow-tags`)

### .github/workflows/release.yml

Triggered on `v*` tag push:
- **release** job: creates a GitHub Release with auto-generated release notes
- **publish-github-packages** job: publishes the package to GitHub Packages (`npm.pkg.github.com`)

## Configuration Flow

1. User creates/edits `config.jsonc` (or `config.json`)
2. `lib/config.js` loads configuration on startup
3. Configuration merged with defaults, namespaced key mapping, and env overrides
4. Passed to all features via constructor

## Data Flow

### Indexing Flow

```
User code files
    ↓
exclude patterns and smart indexing (ignore-patterns.js, project-detector.js)
    ↓
smartChunk() — split into chunks (utils.js)
    ↓
embedder — generate vectors (worker pool, child process, or main thread)
    ↓
EmbeddingsCache — store in memory + disk (cache.js, vector-store-*.js)
    ↓
ANN index (optional) — build/load from cache
    ↓
checkpoint save — persist progress periodically (index-codebase.js)
    ↓
memory cleanup policy — optional model/vector release
```

### Search Flow

```
User query
    ↓
embedder — query to vector (main thread or query child process)
    ↓
ANN candidate search (optional)
    ↓
dotSimilarity() — score candidates
    ↓
exact match + recency + call-graph boosts
    ↓
sort and filter — top N results
    ↓
format output — markdown with code blocks
```

## Performance Considerations

### Caching Strategy

- **First Run**: Download model (if not cached), index all files, save cache
- **Subsequent Runs**: Load cache from disk, only index changed files
- **File Changes**: Incremental updates via file watcher (if enabled)
- **Binary/SQLite Store**: Optional on-disk vector/content storage to reduce JS heap usage
- **Disk Vector Mode**: `vectorStore.vectorStoreLoadMode=disk` streams vectors to lower steady-state RSS
- **Checkpoint Saves**: Indexing progress is checkpointed to disk so interrupted runs can resume

### Memory Usage

Approximate memory usage:

- Base (Node.js + libraries): ~50MB
- Embedding model: ~0.5GB-1.5GB (model/runtime dependent)
- Vector store: ~10KB per code chunk
- Example: 1000 files × 20 chunks/file = ~200MB

### Optimization Tips

- Reduce `chunkSize` for large codebases
- Disable `watchFiles` if not needed
- Use `excludePatterns` aggressively
- Use `memoryCleanup.unloadModelAfterIndex=true` (default) to free ~500MB-1GB after indexing
- Use `vectorStore.vectorStoreLoadMode=disk` and `memoryCleanup.clearCacheAfterIndex=true` for minimal RSS
