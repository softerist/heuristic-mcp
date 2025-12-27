import { glob } from "glob";
import fs from "fs/promises";
import chokidar from "chokidar";
import path from "path";
import { smartChunk, hashContent } from "../lib/utils.js";

export class CodebaseIndexer {
  constructor(embedder, cache, config) {
    this.embedder = embedder;
    this.cache = cache;
    this.config = config;
    this.watcher = null;
  }

  async indexFile(file) {
    const fileName = path.basename(file);
    if (this.config.verbose) {
      console.error(`[Indexer] Processing: ${fileName}...`);
    }
    
    try {
      // Check file size first
      const stats = await fs.stat(file);
      
      // Skip directories
      if (stats.isDirectory()) {
        return 0;
      }
      
      if (stats.size > this.config.maxFileSize) {
        if (this.config.verbose) {
          console.error(`[Indexer] Skipped ${fileName} (too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
        }
        return 0;
      }
      
      const content = await fs.readFile(file, "utf-8");
      const hash = hashContent(content);
      
      // Skip if file hasn't changed
      if (this.cache.getFileHash(file) === hash) {
        if (this.config.verbose) {
          console.error(`[Indexer] Skipped ${fileName} (unchanged)`);
        }
        return 0;
      }

      if (this.config.verbose) {
        console.error(`[Indexer] Indexing ${fileName}...`);
      }
      
      // Remove old chunks for this file
      this.cache.removeFileFromStore(file);
      
      const chunks = smartChunk(content, file, this.config);
      let addedChunks = 0;

      for (const chunk of chunks) {
        try {
          const output = await this.embedder(chunk.text, { pooling: "mean", normalize: true });
          
          this.cache.addToStore({
            file,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content: chunk.text,
            vector: Array.from(output.data)
          });
          addedChunks++;
        } catch (embeddingError) {
          console.error(`[Indexer] Failed to embed chunk in ${fileName}:`, embeddingError.message);
        }
      }

      this.cache.setFileHash(file, hash);
      if (this.config.verbose) {
        console.error(`[Indexer] Completed ${fileName} (${addedChunks} chunks)`);
      }
      return addedChunks;
    } catch (error) {
      console.error(`[Indexer] Error indexing ${fileName}:`, error.message);
      return 0;
    }
  }

  async indexAll() {
    console.error(`[Indexer] Indexing files in ${this.config.searchDirectory}...`);
    
    const pattern = `${this.config.searchDirectory}/**/*.{${this.config.fileExtensions.join(",")}}`;
    const files = await glob(pattern, { 
      ignore: this.config.excludePatterns,
      absolute: true 
    });

    console.error(`[Indexer] Found ${files.length} files to process`);
    
    let totalChunks = 0;
    let processedFiles = 0;
    let skippedFiles = 0;
    
    // Process files in parallel batches for speed
    const BATCH_SIZE = this.config.batchSize || 100;
    
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      
      // Process batch in parallel
      const results = await Promise.all(
        batch.map(file => this.indexFile(file))
      );
      
      // Aggregate results
      for (const chunksAdded of results) {
        totalChunks += chunksAdded;
        processedFiles++;
        if (chunksAdded === 0) skippedFiles++;
      }
      
      // Progress indicator every 500 files (less console overhead)
      if (processedFiles % 500 === 0 || processedFiles === files.length) {
        console.error(`[Indexer] Progress: ${processedFiles}/${files.length} files processed...`);
      }
    }

    console.error(`[Indexer] Indexed ${totalChunks} code chunks from ${files.length} files (${skippedFiles} unchanged)`);
    await this.cache.save();
  }

  setupFileWatcher() {
    if (!this.config.watchFiles) return;

    const pattern = this.config.fileExtensions.map(ext => `**/*.${ext}`);
    
    this.watcher = chokidar.watch(pattern, {
      cwd: this.config.searchDirectory,
      ignored: this.config.excludePatterns,
      persistent: true,
      ignoreInitial: true
    });

    this.watcher
      .on("add", async (filePath) => {
        const fullPath = path.join(this.config.searchDirectory, filePath);
        console.error(`[Indexer] New file detected: ${filePath}`);
        await this.indexFile(fullPath);
        await this.cache.save();
      })
      .on("change", async (filePath) => {
        const fullPath = path.join(this.config.searchDirectory, filePath);
        console.error(`[Indexer] File changed: ${filePath}`);
        await this.indexFile(fullPath);
        await this.cache.save();
      })
      .on("unlink", (filePath) => {
        const fullPath = path.join(this.config.searchDirectory, filePath);
        console.error(`[Indexer] File deleted: ${filePath}`);
        this.cache.removeFileFromStore(fullPath);
        this.cache.deleteFileHash(fullPath);
        this.cache.save();
      });

    console.error("[Indexer] File watcher enabled for incremental indexing");
  }
}

// MCP Tool definition for this feature
export function getToolDefinition() {
  return {
    name: "b_index_codebase",
    description: "Manually trigger a full reindex of the codebase. This will scan all files and update the embeddings cache. Useful after large code changes or if the index seems out of date.",
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "Force reindex even if files haven't changed",
          default: false
        }
      }
    },
    annotations: {
      title: "Reindex Codebase",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  };
}

// Tool handler
export async function handleToolCall(request, indexer) {
  const force = request.params.arguments?.force || false;
  
  if (force) {
    // Clear cache to force full reindex
    indexer.cache.setVectorStore([]);
    indexer.cache.fileHashes = new Map();
  }
  
  await indexer.indexAll();
  
  const vectorStore = indexer.cache.getVectorStore();
  const stats = {
    totalChunks: vectorStore.length,
    totalFiles: new Set(vectorStore.map(v => v.file)).size
  };
  
  return {
    content: [{
      type: "text",
      text: `Codebase reindexed successfully.\n\nStatistics:\n- Files indexed: ${stats.totalFiles}\n- Code chunks: ${stats.totalChunks}`
    }]
  };
}
