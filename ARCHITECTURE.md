# Architecture Overview

This document outlines the modular architecture of Heuristic MCP.

## Directory Structure

```
heuristic-mcp/
├── index.js                    # Main entry point, MCP server setup
├── package.json                # Package configuration
├── config.json                 # Sample configuration
├── LICENSE                     # MIT License
├── README.md                   # Project documentation
├── ARCHITECTURE.md             # Architecture notes
├── CONTRIBUTING.md             # Contribution guide
├── .gitignore                  # Git ignore rules
│
├── lib/                        # Core libraries
│   ├── cache-utils.js         # Stale cache detection/cleanup
│   ├── cache.js               # Embeddings cache management + ANN index
│   ├── call-graph.js          # Symbol extraction and call graph helpers
│   ├── cli.js                 # CLI argument parsing helpers
│   ├── config.js              # Configuration loader and env overrides
│   ├── embedding-process.js   # Child-process embedder runner (isolation)
│   ├── embedding-worker.js    # Worker-thread embedder runner
│   ├── ignore-patterns.js     # Smart ignore patterns by project type
│   ├── json-worker.js         # Off-thread JSON parsing
│   ├── json-writer.js         # Streaming JSON writer
│   ├── logging.js             # Log file + stderr redirection helpers
│   ├── project-detector.js    # Language/project detection
│   ├── tokenizer.js           # Token estimation and limits
│   ├── utils.js               # Shared utilities (chunking, similarity)
│   └── vector-store-binary.js # Binary on-disk vector store (mmap-friendly)
│
├── features/                   # Pluggable features
│   ├── hybrid-search.js       # Semantic + exact match search
│   ├── index-codebase.js      # Code indexing feature
│   ├── clear-cache.js         # Cache management feature
│   ├── find-similar-code.js   # Similarity search by code snippet
│   ├── ann-config.js          # ANN configuration tool
│   ├── lifecycle.js           # CLI lifecycle helpers
│   └── register.js            # IDE registration logic
│
├── scripts/                    # Utility scripts
│   ├── clear-cache.js         # Cache management utility
│   ├── download-model.js      # Optional model pre-download
│   └── postinstall.js         # Auto-register on install
│
└── tools/                      # Developer-only helpers
    └── scripts/
        ├── cache-stats.js     # Cache inspection utility
        └── manual-search.js   # Manual semantic search helper
```

## Module Responsibilities

### index.js

- MCP server initialization
- Feature registry and orchestration
- Tool request routing
- Global state management (embedder, cache)

### lib/config.js

- Loads and validates configuration from `config.json`
- Provides default configuration values
- Resolves file paths and cache location
- Applies `SMART_CODING_*` environment variable overrides

### lib/cache.js

- **EmbeddingsCache** class
- Manages persistence of embedding vectors
- File hash tracking for change detection
- Load/save operations for disk cache
- Optional ANN (HNSW) index build/load/save for fast search
- Supports JSON or binary vector store formats

### lib/cache-utils.js

- Stale cache detection/cleanup for caches without metadata
- Uses `progress.json` recency to avoid deleting active indexes

### lib/embedding-process.js

- Child-process embedding path for isolation
- Used to recover from hung or crashing workers

### lib/embedding-worker.js

- Worker-thread embedding path for concurrency
- Cooperates with worker circuit breaker logic in indexing

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

### lib/utils.js

- **dotSimilarity()** - Vector similarity calculation
- **hashContent()** - MD5 hashing for change detection
- **smartChunk()** - Language-aware code chunking

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
- Incremental indexing
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

## Configuration Flow

1. User creates/edits `config.json`
2. `lib/config.js` loads configuration on startup
3. Configuration merged with defaults and env overrides
4. Passed to all features via constructor

## Data Flow

### Indexing Flow

```
User code files
    ↓
exclude patterns and smart indexing
    ↓
smartChunk() - split into chunks
    ↓
embedder - generate vectors
    ↓
EmbeddingsCache - store in memory + disk
    ↓
ANN index (optional) - build/load from cache
```

### Search Flow

```
User query
    ↓
embedder - query to vector
    ↓
ANN candidate search (optional)
    ↓
dotSimilarity() - score candidates
    ↓
exact match + recency + call-graph boosts
    ↓
sort and filter - top N results
    ↓
format output - markdown with code blocks
```

## Performance Considerations

### Caching Strategy

- **First Run**: Download model (if not cached), index all files, save cache
- **Subsequent Runs**: Load cache from disk, only index changed files
- **File Changes**: Incremental updates via file watcher (if enabled)
- **Binary Store**: Optional on-disk vector/content storage to reduce JS heap usage

### Memory Usage

Approximate memory usage:

- Base (Node.js + libraries): ~50MB
- Embedding model: ~100MB
- Vector store: ~10KB per code chunk
- Example: 1000 files × 20 chunks/file = ~200MB

### Optimization Tips

- Reduce `chunkSize` for large codebases
- Disable `watchFiles` if not needed
- Use `excludePatterns` aggressively
