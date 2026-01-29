# Heuristic MCP

## Project Overview

**@softerist/heuristic-mcp** is an enhanced Model Context Protocol (MCP) server designed to provide intelligent semantic code search capabilities. It integrates features like find-similar-code, recency-aware ranking, call-graph proximity boosts, and smart chunking to improve code retrieval accuracy for AI assistants (Antigravity, Cursor, Claude Desktop, VS Code).

**Key Features:**
*   **Semantic Search:** Finds code by meaning using embeddings.
*   **Smart Indexing:** Automatically detects project types and applies ignores.
*   **Recency & Proximity:** Boosts results based on file modification time and call graph relationships.
*   **ANN Index:** Optional Approximate Nearest Neighbor index for performance on large codebases.
*   **Zero-touch Setup:** Auto-registers with supported IDEs.

## Architecture

The project follows a modular architecture:

*   **`index.js`**: Main entry point. Initializes the MCP server, loads configuration, and registers features.
*   **`lib/`**: Core libraries.
    *   `config.js`: Configuration loader and environment variable handling.
    *   `cache.js`: Manages embedding vectors persistence and ANN index.
    *   `cache-utils.js`: Stale cache detection/cleanup.
    *   `utils.js`: Shared utilities (hashing, similarity, smart chunking).
    *   `call-graph.js`: Extracts symbols and builds a lightweight call graph.
    *   `tokenizer.js`: Token estimation.
    *   `embedding-worker.js`: Worker-thread embedder runner.
    *   `embedding-process.js`: Child-process embedder runner (isolation).
    *   `ignore-patterns.js`: Smart ignore patterns by detected project type.
    *   `json-worker.js` / `json-writer.js`: Streaming JSON helpers.
    *   `logging.js`: Log file helpers.
*   **`features/`**: Pluggable feature modules. Each module exports a class, tool definition, and handler.
    *   `hybrid-search.js`: Semantic search logic.
    *   `index-codebase.js`: File discovery and indexing.
    *   `find-similar-code.js`: Logic for finding similar snippets.
    *   `lifecycle.js` & `register.js`: CLI and IDE registration helpers.
*   **`scripts/`**: Utility scripts (postinstall, model download, cache clearing).
*   **`tools/`**: Developer-only helpers (manual search script).

## Building and Running

### Prerequisites
*   Node.js >= 18.0.0

### Key Commands

| Command | Description |
| :--- | :--- |
| `npm start` | Runs the server (production mode). |
| `npm run dev` | Runs the server in development mode (watch mode). |
| `npm test` | Runs the test suite using Vitest. |
| `npm run clean` | Clears the cache directory. |
| `npm run lint` | Runs ESLint. |
| `npm run format` | Runs Prettier. |

**Note on Testing:** Tests are configured to run sequentially (`fileParallelism: false`) to manage memory usage of the embedding models. Use `USE_REAL_EMBEDDER=true npm test` to test with the actual model instead of mocks.

## Development Conventions

*   **Style:** Modern ES6+ JavaScript.
*   **Modularity:** New features should be added as separate modules in `features/` following the pattern:
    1.  **Class:** `export class FeatureName { ... }`
    2.  **Tool Def:** `export function getToolDefinition(config) { ... }`
    3.  **Handler:** `export async function handleToolCall(request, instance) { ... }`
*   **Logging:** Use `console.info()` for normal server lifecycle output (redirected to logs when running in MCP mode). Use `console.warn()` for non-fatal issues and `console.error()` for errors. CLI utilities may also use `console.info()` for user-facing output.
*   **Configuration:** All features should accept a `config` object. Environment variables (prefix `SMART_CODING_`) override `config.json` values.

## Key Files

*   **`package.json`**: Dependencies and scripts.
*   **`config.json`**: Default/example configuration.
*   **`ARCHITECTURE.md`**: Detailed architectural documentation.
*   **`CONTRIBUTING.md`**: Guidelines for contributors.
*   **`vitest.config.js`**: Test runner configuration.
