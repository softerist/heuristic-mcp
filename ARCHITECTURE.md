# Project Structure

This document outlines the modular architecture of Smart Coding MCP.

## Directory Structure

```
smart-coding-mcp/
├── index.js                    # Main entry point, MCP server setup
├── package.json                # Package configuration
├── config.json                 # User configuration
├── LICENSE                     # MIT License
├── README.md                   # Project documentation
├── EXAMPLES.md                 # Usage examples
├── .gitignore                  # Git ignore rules
│
├── lib/                        # Core libraries
│   ├── config.js              # Configuration loader
│   ├── cache.js               # Embeddings cache management
│   └── utils.js               # Shared utilities (chunking, similarity)
│
├── features/                   # Pluggable features
│   ├── hybrid-search.js       # Semantic search feature
│   ├── index-codebase.js      # Code indexing feature
│   └── clear-cache.js         # Cache management feature
│
└── scripts/                    # Utility scripts
    └── clear-cache.js         # Cache management utility
```

## Module Responsibilities

### index.js

- MCP server initialization
- Feature registry and orchestration
- Tool request routing
- Global state management (embedder, cache)

### lib/config.js

- Loads and validates configuration from config.json
- Provides default configuration values
- Resolves file paths

### lib/cache.js

- **EmbeddingsCache** class
- Manages persistence of embedding vectors
- File hash tracking for change detection
- Load/save operations for disk cache

### lib/utils.js

- **cosineSimilarity()** - Vector similarity calculation
- **hashContent()** - MD5 hashing for change detection
- **smartChunk()** - Language-aware code chunking

### features/hybrid-search.js

- **HybridSearch** class
- Combines semantic and exact matching
- Weighted scoring algorithm
- Result formatting with relevance scores
- MCP tool: `semantic_search`

### features/index-codebase.js

- **CodebaseIndexer** class
- File discovery via glob patterns
- Incremental indexing
- File watcher for real-time updates
- MCP tool: `index_codebase`

## Adding New Features

To extend with a new feature:

### 1. Create Feature Module

Create `features/my-feature.js`:

```javascript
export class MyFeature {
  constructor(embedder, cache, config) {
    this.embedder = embedder;
    this.cache = cache;
    this.config = config;
  }

  async execute(params) {
    // Implementation
    return {
      /* results */
    };
  }
}

export function getToolDefinition(config) {
  return {
    name: "my_tool",
    description: "What this tool does",
    inputSchema: {
      type: "object",
      properties: {
        param1: { type: "string", description: "..." },
      },
      required: ["param1"],
    },
  };
}

export async function handleToolCall(request, instance) {
  const params = request.params.arguments;
  const result = await instance.execute(params);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
```

### 2. Register in index.js

```javascript
import * as MyFeature from "./features/my-feature.js";

// In initialize():
const myFeature = new MyFeature.MyFeature(embedder, cache, config);

// Add to features array:
const features = [
  // ... existing features
  {
    module: MyFeature,
    instance: myFeature,
    handler: MyFeature.handleToolCall,
  },
];
```

### 3. Done!

The feature will automatically:

- Be listed in MCP tool discovery
- Handle incoming tool requests
- Have access to embeddings and cache

## Configuration Flow

1. User creates/edits `config.json`
2. `lib/config.js` loads configuration on startup
3. Configuration merged with defaults
4. Passed to all features via constructor

## Data Flow

### Indexing Flow

```
User code files
    ↓
glob pattern matching
    ↓
smartChunk() - split into chunks
    ↓
embedder - generate vectors
    ↓
EmbeddingsCache - store in memory + disk
```

### Search Flow

```
User query
    ↓
embedder - query to vector
    ↓
cosineSimilarity() - score all chunks
    ↓
exact match boost - adjust scores
    ↓
sort and filter - top N results
    ↓
format output - markdown with syntax highlighting
```

## Performance Considerations

### Caching Strategy

- **First Run**: Download model (~90MB), index all files, save cache
- **Subsequent Runs**: Load cache from disk, only index changed files
- **File Changes**: Incremental updates via file watcher

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
- Limit `fileExtensions` to relevant types

## Future Feature Ideas

Potential features to add following this architecture:

1. **Code Complexity Analysis**

   - Cyclomatic complexity scoring
   - Technical debt detection

2. **Pattern Detection**

   - Anti-pattern identification
   - Best practice recommendations

3. **Documentation Generation**

   - Auto-generate function docs
   - README generation from code

4. **Refactoring Suggestions**

   - Code smell detection
   - Automated fix suggestions

5. **Test Coverage Analysis**

   - Identify untested code paths
   - Generate test templates

6. **Dependency Analysis**
   - Import/export graph
   - Dead code detection

Each feature would follow the same pattern:

- Class in `features/` directory
- Access to embedder, cache, config
- MCP tool definition and handler
- Registration in feature array

## Testing Strategy

Recommended testing approach:

1. **Unit Tests**: lib/ modules

   - Test utilities in isolation
   - Mock dependencies

2. **Integration Tests**: features/

   - Test with sample codebases
   - Verify MCP tool contracts

3. **E2E Tests**: Full workflow
   - Index → Search → Results
   - File watching behavior
   - Cache persistence

## Error Handling

Each module follows defensive error handling:

- Config errors → use defaults
- File read errors → log and skip
- Embedding errors → retry or skip chunk
- Cache errors → log but continue
- Unknown tools → return helpful error message

All errors logged to stderr for MCP protocol compatibility.
