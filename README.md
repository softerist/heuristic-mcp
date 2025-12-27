# Smart Coding MCP

An extensible Model Context Protocol (MCP) server that provides intelligent semantic code search for AI assistants. Built with local AI models, inspired by Cursor's semantic search research.

## What This Does

AI coding assistants work better when they can find relevant code quickly. Traditional keyword search falls short - if you ask "where do we handle authentication?" but your code uses "login" and "session", keyword search misses it.

This MCP server solves that by indexing your codebase with AI embeddings. Your AI assistant can search by meaning instead of exact keywords, finding relevant code even when the terminology differs.

## Why Use This

**Better Code Understanding**

- Search finds code by concept, not just matching words
- Works with typos and variations in terminology
- Natural language queries like "where do we validate user input?"

**Performance**

- Pre-indexed embeddings are faster than scanning files at runtime
- Smart project detection skips dependencies automatically (node_modules, vendor, etc.)
- Incremental updates - only re-processes changed files

**Privacy**

- Everything runs locally on your machine
- Your code never leaves your system
- No API calls to external services

## Installation

Install globally via npm:

```bash
npm install -g smart-coding-mcp
```

## Configuration

Add to your MCP configuration file (e.g., `~/.config/claude/mcp.json` or similar):

### Option 1: Specific Project (Recommended)

```json
{
  "mcpServers": {
    "smart-coding-mcp": {
      "command": "smart-coding-mcp",
      "args": ["--workspace", "/absolute/path/to/your/project"]
    }
  }
}
```

### Option 2: Multi-Project Support

```json
{
  "mcpServers": {
    "smart-coding-mcp-project-a": {
      "command": "smart-coding-mcp",
      "args": ["--workspace", "/path/to/project-a"]
    },
    "smart-coding-mcp-project-b": {
      "command": "smart-coding-mcp",
      "args": ["--workspace", "/path/to/project-b"]
    }
  }
}
```

### Option 3: Auto-Detect Current Directory

```json
{
  "mcpServers": {
    "smart-coding-mcp": {
      "command": "smart-coding-mcp"
    }
  }
}
```

## Environment Variables

Override configuration settings via environment variables in your MCP config:

| Variable                      | Type    | Default   | Description                    |
| ----------------------------- | ------- | --------- | ------------------------------ |
| `SMART_CODING_VERBOSE`        | boolean | `false`   | Enable detailed logging        |
| `SMART_CODING_BATCH_SIZE`     | number  | `100`     | Files to process in parallel   |
| `SMART_CODING_MAX_FILE_SIZE`  | number  | `1048576` | Max file size in bytes (1MB)   |
| `SMART_CODING_CHUNK_SIZE`     | number  | `15`      | Lines of code per chunk        |
| `SMART_CODING_MAX_RESULTS`    | number  | `5`       | Max search results             |
| `SMART_CODING_SMART_INDEXING` | boolean | `true`    | Enable smart project detection |

**Example with environment variables:**

```json
{
  "mcpServers": {
    "smart-coding-mcp": {
      "command": "smart-coding-mcp",
      "args": ["--workspace", "/path/to/project"],
      "env": {
        "SMART_CODING_VERBOSE": "true",
        "SMART_CODING_BATCH_SIZE": "200",
        "SMART_CODING_MAX_FILE_SIZE": "2097152"
      }
    }
  }
}
```

**Note**: The server starts instantly and indexes in the background, so your IDE won't be blocked waiting for indexing to complete.

## Available Tools

**semantic_search** - Find code by meaning

```
Query: "Where do we validate user input?"
Returns: Relevant validation code with file paths and line numbers
```

**index_codebase** - Manually trigger reindexing

```
Use after major refactoring or branch switches
```

**clear_cache** - Reset the embeddings cache

```
Useful when cache becomes corrupted or outdated
```

## How It Works

The server indexes your code in four steps:

1. **Discovery**: Scans your project for source files
2. **Chunking**: Breaks code into meaningful pieces (respecting function boundaries)
3. **Embedding**: Converts each chunk to a vector using a local AI model
4. **Storage**: Saves embeddings to `.smart-coding-cache/` for fast startup

When you search, your query is converted to the same vector format and compared against all code chunks using cosine similarity. The most relevant matches are returned.

### Smart Project Detection

The server detects your project type by looking for marker files and automatically applies appropriate ignore patterns:

**JavaScript/Node** (package.json found)

- Ignores: node_modules, dist, build, .next, coverage

**Python** (requirements.txt or pyproject.toml)

- Ignores: **pycache**, venv, .pytest_cache, .tox

**Android** (build.gradle)

- Ignores: .gradle, build artifacts, generated code

**iOS** (Podfile)

- Ignores: Pods, DerivedData, xcuserdata

**And more**: Go, PHP, Rust, Ruby, .NET

This typically reduces indexed file count by 100x. A project with 50,000 files (including node_modules) indexes just 500 actual source files.

## Configuration

The server works out of the box with sensible defaults. Create a `config.json` file in your workspace to customize:

```json
{
  "searchDirectory": ".",
  "fileExtensions": ["js", "ts", "py", "java", "go"],
  "excludePatterns": ["**/my-custom-ignore/**"],
  "smartIndexing": true,
  "verbose": false,
  "enableCache": true,
  "cacheDirectory": "./.smart-coding-cache",
  "watchFiles": true,
  "chunkSize": 15,
  "batchSize": 100,
  "maxFileSize": 1048576,
  "maxResults": 5
}
```

**Key options:**

- `smartIndexing`: Enable automatic project type detection and smart ignore patterns (default: true)
- `verbose`: Show detailed indexing logs (default: false)
- `watchFiles`: Automatically reindex when files change (default: true)
- `enableCache`: Cache embeddings to disk (default: true)
- `chunkSize`: Lines of code per chunk - smaller = more precise, larger = more context (default: 15)
- `batchSize`: Number of files to process in parallel (default: 100)
- `maxFileSize`: Skip files larger than this size in bytes (default: 1MB)

## Examples

**Natural language search:**

Query: "How do we handle cache persistence?"

Result:

```javascript
// lib/cache.js (Relevance: 38.2%)
async save() {
  await fs.writeFile(cacheFile, JSON.stringify(this.vectorStore));
  await fs.writeFile(hashFile, JSON.stringify(this.fileHashes));
}
```

**Typo tolerance:**

Query: "embeding modle initializashun"

Still finds embedding model initialization code despite multiple typos.

**Conceptual search:**

Query: "error handling and exceptions"

Finds all try/catch blocks and error handling patterns.

## Performance

Tested on a typical JavaScript project:

| Metric         | Without Smart Indexing | With Smart Indexing |
| -------------- | ---------------------- | ------------------- |
| Files scanned  | 50,000+                | 500                 |
| Indexing time  | 10+ min                | 2-3 min             |
| Memory usage   | 2GB+                   | ~200MB              |
| Search latency | N/A                    | <100ms              |

## Supported File Types

Languages: JavaScript, TypeScript, Python, Java, Kotlin, Scala, C, C++, C#, Go, Rust, Ruby, PHP, Swift, Shell

Web: HTML, CSS, SCSS, Sass, XML, SVG

Config/Data: JSON, YAML, TOML, SQL

Total: 36 file extensions

## Architecture

```
smart-coding-mcp/
├── index.js                  # MCP server entry point
├── lib/
│   ├── config.js            # Configuration + smart detection
│   ├── cache.js             # Embeddings persistence
│   ├── utils.js             # Smart chunking
│   ├── ignore-patterns.js   # Language-specific patterns
│   └── project-detector.js  # Project type detection
└── features/
    ├── hybrid-search.js     # Semantic + exact match search
    ├── index-codebase.js    # File indexing + watching
    └── clear-cache.js       # Cache management
```

The modular design makes it easy to add new features. See ARCHITECTURE.md for implementation details.

## Troubleshooting

**"Server can't find config.json"**

Make sure `cwd` is set in your MCP configuration to the full path of smart-coding-mcp.

**"Indexing takes too long"**

- Verify `smartIndexing` is enabled
- Add more patterns to `excludePatterns`
- Reduce `fileExtensions` to only what you need

**"Search results aren't relevant"**

- Try more specific queries
- Increase `maxResults` to see more options
- Run `index_codebase` to force a full reindex

**"Cache corruption errors"**

Use the `clear_cache` tool or run:

```bash
npm run clear-cache
```

## CLI Commands

```bash
# Start the server
npm start

# Development mode with auto-restart
npm run dev

# Clear embeddings cache
npm run clear-cache
```

## Privacy

- AI model runs entirely on your machine
- No network requests to external services
- No telemetry or analytics
- Cache stored locally in `.smart-coding-cache/`

## Technical Details

**Embedding Model**: all-MiniLM-L6-v2 via transformers.js

- Fast inference (CPU-friendly)
- Small model size (~100MB)
- Good accuracy for code search

**Vector Similarity**: Cosine similarity

- Efficient comparison of embeddings
- Normalized vectors for consistent scoring

**Hybrid Scoring**: Combines semantic similarity with exact text matching

- Semantic weight: 0.7 (configurable)
- Exact match boost: 1.5x (configurable)

## Research Background

This project builds on research from Cursor showing that semantic search improves AI coding agent performance by 12.5% on average across question-answering tasks. The key insight is that AI assistants benefit more from relevant context than from large amounts of context.

See: https://cursor.com/blog/semsearch

## Contributing

Contributions are welcome. See CONTRIBUTING.md for guidelines.

Potential areas for improvement:

- Additional language support
- Code complexity analysis
- Refactoring pattern detection
- Documentation generation

## License

MIT License

Copyright (c) 2025 Omar Haris

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
