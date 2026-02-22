# Heuristic MCP Server

Heuristic MCP adds smart code search to your editor or MCP client.

## Requirements

- Node.js `18+`
- npm (for global install)
- Internet access at least once to download the embedding model (if install-time download is skipped, it downloads on first run)
- 64-bit Node.js recommended for native ONNX performance; on Windows, install Microsoft Visual C++ 2015-2022 Redistributable (x64) if native bindings fail

## Install

```bash
npm install -g @softerist/heuristic-mcp
```

Then enable it for your client:

```bash
heuristic-mcp --start
```

If your editor was already open, reload it once.

## How It Works

1. The server scans your workspace and builds a searchable index of your code.
2. IDE AI models/MCP tools query that index using plain language so you can find relevant code quickly.
3. Results improve as your index stays up to date with project changes.

## Basic Commands

```bash
heuristic-mcp --status
heuristic-mcp --logs
heuristic-mcp --stop
```

Use `heuristic-mcp --status` first if something looks off.
Use `heuristic-mcp --cache` to see the cache status or file index progress.

## Advanced Docs

Detailed configuration, tool reference, troubleshooting, and release notes are in:

- [`docs/GUIDE.md`](docs/GUIDE.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

License: MIT
