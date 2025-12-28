# Heuristic MCP

[![npm version](https://img.shields.io/npm/v/@softerist/heuristic-mcp.svg)](https://www.npmjs.com/package/@softerist/heuristic-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@softerist/heuristic-mcp.svg)](https://www.npmjs.com/package/@softerist/heuristic-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)

An extensible Model Context Protocol (MCP) server that provides intelligent semantic code search for AI assistants. Built with local AI models (RAG), inspired by Cursor's semantic search research.

## What This Does

AI coding assistants work better when they can find relevant code quickly. Traditional keyword search falls short - if you ask "where do we handle authentication?" but your code uses "login" and "session", keyword search misses it.

This MCP server solves that by indexing your codebase with AI embeddings. Your AI assistant can search by meaning instead of exact keywords, finding relevant code even when the terminology differs.

## Example: Semantic Search in Action

**User Query:** "How vector cache working?"

### MCP Tool Call

```json
{
  "maxResults": 5,
  "query": "vector store embeddings cache save load"
}
```

### Output

**Result 1 (Relevance: 72.5%)**

**File:** `lib/cache.js` **Lines:** 42-59

```javascript
}

    const filtered = rawVectorStore.length - this.vectorStore.length;
    if (filtered > 0) {
        console.error(`[Cache] Filtered ${filtered} outdated cache entries`);
    }
    console.error(`[Cache] Loaded ${this.vectorStore.length} cached embeddings`);
```

Here's how the **vector cache** works:

### Overview

The cache system (`lib/cache.js`) stores two things:

1. **Vector embeddings** - AI-generated vectors for each code chunk
2. **File hashes** - MD5 hashes to detect file changes

## Why Heuristic MCP is Useful

Yes, absolutely. The **Heuristic MCP** is highly effective because it bridges the gap between "having access to files" and "understanding the codebase." Here is why it is useful:

### 1. It Solved the "Needle in a Haystack" Problem

To answer your technical questions, I didn't have to manually browse 15 files or run generic `grep` commands.

- **Without MCP:** I would have listed directories, guessed `lib/utils.js` might be relevant, read the whole file, then checked `index.js`, etc.
- **With MCP:** I asked *"how does chunking work"* and it instantly returned lines 91-108 of `lib/utils.js`. It acted like a senior engineer pointing me to the exact lines of code.

### 2. It Finds "Concepts," Not Just Words

Standard tools like `grep` only find exact matches.

- If I searched for "authentication" using `grep`, I might miss a function named `verifyUserCredentials`.
- The **Heuristic MCP** links these concepts. In the test script I analyzed earlier, `authentication` correctly matched with `credentials` because of the vector similarity.

### 3. It Finds "Similar Code"

AI agents have a limited memory (context window).

- Instead of reading **every file** to understand the project (which wastes thousands of tokens), the MCP lets me retrieve **only the 5-10 relevant snippets**. This leaves more room for complex reasoning and generating code.

### 4. It Is Fast & Private

Since it runs the **Local LLM** (Xenova) directly on your machine:

- **Latency is near-zero** (<50ms).
- **Privacy is 100%**: Your source code never leaves your laptop to be indexed by an external cloud service.

### Verdict

For a developer (or an AI agent) working on a confusing or large project, this tool is a massive productivity booster. It essentially turns the entire codebase into a searchable database of knowledge.

## How This is Different

Most MCP servers and RAG tools are "naive"—they just embed code chunks and run a vector search. **Heuristic MCP** is different because it adds **deterministic intelligence** on top of AI:

| Feature | Generic MCP / RAG Tool | Heuristic MCP |
| :- | :- | :- |
| **Ranking** | Pure similarity score | Similarity + **Call Graph Proximity** + **Recency Boost** |
| **Logic** | "Is this text similar?" | "Is this similar, AND used by this function, AND active?" |
| **Refactoring** | N/A | **`find_similar_code`** tool to detect duplicates |
| **Tuning** | Static (hardcoded) | **Runtime Config** (adjust ANN parameters on the fly) |

### Comparison to Cursor

[Cursor](https://cursor.sh) is an excellent AI editor with built-in codebase indexing.

- **Cursor** is an *Editor*: You must use their IDE to get the features.
- **Heuristic MCP** is a *Protocol*: It brings Cursor-like intelligence to **any** tool (Claude Desktop, multiple IDEs, agentic workflows) without locking you into a specific editor.
- **Transparency**: This is open-source. You know exactly how your code is indexed and where the data lives (locally).

## Performance

- Pre-indexed embeddings are faster than scanning files at runtime
- Smart project detection skips dependencies automatically (node_modules, vendor, etc.)
- Incremental updates - only re-processes changed files
- Optional ANN search (HNSW) for faster queries on large codebases

## Privacy

- Everything runs locally on your machine
- Your code never leaves your system
- No API calls to external services

## Installation

Install globally via npm:

```bash
npm install -g @softerist/heuristic-mcp
```

That's it! The installer will automatically detect your IDE (Antigravity, Claude, Cursor) and configure it for you.

| IDE                  | OS      | Config Path                                                       |
| -------------------- | ------- | ----------------------------------------------------------------- |
| **Claude Desktop**   | macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Claude Desktop**   | Windows | `%APPDATA%\Claude\claude_desktop_config.json`                     |
| **Cascade (Cursor)** | All     | Configured via UI Settings > Features > MCP                       |
| **Antigravity**      | macOS   | `~/.gemini/antigravity/mcp_config.json`                           |
| **Antigravity**      | Windows | `%USERPROFILE%\.gemini\antigravity\mcp_config.json`               |

Add the server configuration to the `mcpServers` object in your config file:

### Option 1: Specific Project (Recommended)

```json
{
  "mcpServers": {
    "heuristic-mcp": {
      "command": "heuristic-mcp",
      "args": ["--workspace", "/absolute/path/to/your/project"]
    }
  }
}
```

### Option 2: Multi-Project Support

```json
{
  "mcpServers": {
    "heuristic-mcp-project-a": {
      "command": "heuristic-mcp",
      "args": ["--workspace", "/path/to/project-a"]
    },
    "heuristic-mcp-project-b": {
      "command": "heuristic-mcp",
      "args": ["--workspace", "/path/to/project-b"]
    }
  }
}
```

### Troubleshooting

If for some reason the server isn't detected automatically, you can trigger the registration manually:

```bash
heuristic-mcp --register
```

### Starting and Stopping

If you need to restart the server or kill a zombie process:

**Stop the server:**

```bash
heuristic-mcp --stop
```

*(This kills any running instances of the server)*

**Start/Enable the server:**

```bash
heuristic-mcp --start
```

*(This re-runs the configuration step to ensure it is enabled in your IDE)*

**Check Status:**

```bash
heuristic-mcp --status
```

*(Shows if the server is running and its PID)*

---

## Environment Variables

Override configuration settings via environment variables in your MCP config:

| Variable                         | Type    | Default                   | Description                           |
| -------------------------------- | ------- | ------------------------- | ------------------------------------- |
| `SMART_CODING_VERBOSE`           | boolean | `false`                   | Enable detailed logging               |
| `SMART_CODING_BATCH_SIZE`        | number  | `100`                     | Files to process in parallel          |
| `SMART_CODING_MAX_FILE_SIZE`     | number  | `1048576`                 | Max file size in bytes (1MB)          |
| `SMART_CODING_CHUNK_SIZE`        | number  | `25`                      | Lines of code per chunk               |
| `SMART_CODING_MAX_RESULTS`       | number  | `5`                       | Max search results                    |
| `SMART_CODING_SMART_INDEXING`    | boolean | `true`                    | Enable smart project detection        |
| `SMART_CODING_WATCH_FILES`       | boolean | `false`                   | Enable file watching for auto-reindex |
| `SMART_CODING_SEMANTIC_WEIGHT`   | number  | `0.7`                     | Weight for semantic similarity (0-1)  |
| `SMART_CODING_EXACT_MATCH_BOOST` | number  | `1.5`                     | Boost for exact text matches          |
| `SMART_CODING_RECENCY_BOOST`     | number  | `0.1`                     | Boost for recently modified files     |
| `SMART_CODING_RECENCY_DECAY_DAYS`| number  | `30`                      | Days until recency boost fades to 0   |
| `SMART_CODING_EMBEDDING_MODEL`   | string  | `Xenova/all-MiniLM-L6-v2` | AI embedding model to use             |
| `SMART_CODING_WORKER_THREADS`    | string  | `auto`                    | Worker threads (`auto` or 1-32)       |
| `SMART_CODING_ANN_ENABLED`       | boolean | `true`                    | Enable ANN search (HNSW)              |

**ANN note**: HNSW support uses optional `hnswlib-node`. If it isn't installed, the server falls back to exact (linear) search automatically.

**Example with environment variables:**

```json
{
  "mcpServers": {
    "heuristic-mcp": {
      "command": "heuristic-mcp",
      "args": ["--workspace", "/path/to/project"],
      "env": {
        "SMART_CODING_VERBOSE": "true",
        "SMART_CODING_RECENCY_BOOST": "0.2"
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

**find_similar_code** - Find duplicates or patterns

```
Input: A code snippet (paste the code directly)
Returns: Other code in the project that looks or functions similarly
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

1. **Discovery**: Scans your project for source files (smartly ignoring build/vendor folders)
2. **Chunking**: Breaks code into meaningful pieces (respecting function boundaries)
3. **Embedding**: Converts each chunk to a vector using a local AI model
4. **Storage**: Saves embeddings to `.smart-coding-cache/` for fast startup

When you search, your query is converted to the same vector format. We use a **hybrid ranking algorithm** that combines:

- **Semantic Similarity** (cosine similarity of vectors)
- **Exact Keyword Matching** (BM25-inspired boost)
- **Recency Boosting** (favoring files you're actively working on)

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

See: <https://cursor.com/blog/semsearch>

## Acknowledgements

This project is a fork of [smart-coding-mcp](https://github.com/omar-haris/smart-coding-mcp) by [Omar Haris](https://www.linkedin.com/in/omarharis/). We thank him for the original implementation.

## License

MIT License

Copyright (c) 2025 Softerist

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
