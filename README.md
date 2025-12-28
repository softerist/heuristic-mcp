# Heuristic MCP Server 🧠

> An **enhanced** MCP server for your codebase. It provides **intelligent semantic search**, **Find-Similar-Code**, **Recency Ranking**, and **Smart Chunking**.
> Optimized for Antigravity, Cursor, and Claude Desktop.

---

## 🚀 Key Features

- **Zero-Config Installation**: Automatically detects your IDE (Antigravity, Cursor, Claude) and configures itself.
- **Smart Indexing**: Automatically identifies your project type (Python, JS, etc.) and ignores irrelevant files.
- **Robust Caching**: Pre-downloads AI models to avoid network blocks and caches embeddings globally or locally.
- **Semantic Search**: Finds code by *meaning*, not just keywords (e.g., "auth logic" finds `login.ts`).
- **Resilient**: Self-healing configuration and automatic recovery from race conditions.

---

## 📦 Installation

To install globally (recommended):

```bash
npm install -g @softerist/heuristic-mcp
```

**That's it!**
- The installer automatically creates the `mcp_config.json` for your IDE.
- It pre-downloads the AI model (`all-MiniLM-L6-v2`) to your cache.
- Just **Restart your IDE** (or Reload Window) to start using it.

---

## 🛠️ CLI Commands

The `heuristic-mcp` tool is your control center.

### Check Health & Status (Snapshots)
Use this to verify if the server is running and check indexing progress.
```bash
heuristic-mcp --status
```
**Output:**
- 🟢 **Server Status**: Shows if the background process is running (PID).
- 📁 **Cache Info**: Shows number of files indexed, chunks, and "Initializing..." status if still working.
- ⚙️ **Config Check**: Validates that your IDE config files exist.

### Live Logs (Streaming)
Use this to watch the server's brain at work in real-time.
```bash
heuristic-mcp --logs
```
**Output:**
- Streams live logs from the server.
- Shows file indexing progress (`Processing 100/236 files...`).
- Useful for debugging why a specific file isn't being indexed.

### Manual Registration
If you need to re-register the server manually:
```bash
heuristic-mcp --register
```

### Stop Server
Forcefully stop all running instances:
```bash
heuristic-mcp --stop
```

### Clear Cache
Wipe the index to force a complete rebuild:
```bash
heuristic-mcp --clean
```

---

## ⚙️ Configuration (`config.json`)

You can customize behavior by creating a `config.json` in your project root or `~/.heuristic-mcp/config.json`.

```json
{
  "excludePatterns": ["**/legacy-code/**", "**/*.test.ts"],
  "smartIndexing": true,
  "embeddingModel": "Xenova/all-MiniLM-L6-v2",
  "workerThreads": "auto"
}
```

### Environment Variables
Override settings on the fly:
- `SMART_CODING_VERBOSE=true`: Enable debug logs.
- `SMART_CODING_WORKER_THREADS=4`: Force specific thread count.

---

## 🔧 Troubleshooting

**"Server isn't starting"**
1. Run `heuristic-mcp --status` to see if config files exist.
2. Run `heuristic-mcp --logs` and then Reload Window to see startup errors.

**"Search returns no results"**
- Check `heuristic-mcp --status`. Does it say "Indexing: ✅ COMPLETE"?
- If it says "Initializing...", wait a moment.
- If it says "NO FILES", check your `.gitignore` or `excludePatterns`.

**"Network error downloading model"**
- We pre-download models during `npm install`. Try running `npm install -g @softerist/heuristic-mcp` again to retry the download.

---

## 🤝 Contributing

Fork it, fix it, ship it. Open a PR!

License: MIT
