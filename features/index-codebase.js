import { fdir } from 'fdir';
import fs from 'fs/promises';
import chokidar from 'chokidar';
import path from 'path';
import os from 'os';
import { Worker } from 'worker_threads';
import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath } from 'url';
import { smartChunk, hashContent } from '../lib/utils.js';
import { extractCallData } from '../lib/call-graph.js';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(pattern) {
  let regex = '^';
  for (let i = 0; i < pattern.length; ) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          regex += '(?:.*/)?';
          i += 3;
        } else {
          regex += '.*';
          i += 2;
        }
      } else {
        regex += '[^/]*';
        i += 1;
      }
      continue;
    }
    if (char === '?') {
      regex += '[^/]';
      i += 1;
      continue;
    }
    regex += escapeRegExp(char);
    i += 1;
  }
  regex += '$';
  return new RegExp(regex);
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function toFloat32Array(vector) {
  if (vector instanceof Float32Array) {
    return vector;
  }
  return Float32Array.from(vector);
}

function buildExcludeMatchers(patterns) {
  return [...new Set(patterns)].filter(Boolean).map((pattern) => ({
    matchBase: !pattern.includes('/'),
    regex: globToRegExp(pattern),
  }));
}

function matchesExcludePatterns(filePath, matchers) {
  if (matchers.length === 0) return false;
  const normalized = normalizePath(filePath);
  const basename = path.posix.basename(normalized);

  for (const matcher of matchers) {
    const target = matcher.matchBase ? basename : normalized;
    if (matcher.regex.test(target)) {
      return true;
    }
  }
  return false;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isTestEnv() {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
}

export class CodebaseIndexer {
  constructor(embedder, cache, config, server = null) {
    this.embedder = embedder;
    this.cache = cache;
    this.config = config;
    this.server = server;
    this.watcher = null;
    this.workers = [];
    this.workerReady = [];
    this.isIndexing = false;
    this.processingWatchEvents = false;
    this.pendingWatchEvents = new Map();
    this.excludeMatchers = buildExcludeMatchers(this.config.excludePatterns || []);
  }

  /**
   * Initialize worker thread pool for parallel embedding
   */
  async initializeWorkers() {

    let numWorkers =
      this.config.workerThreads === 'auto'
        ? Math.min(2, Math.max(1, os.cpus().length - 1)) // Cap 'auto' at 2 workers
        : typeof this.config.workerThreads === 'number'
          ? this.config.workerThreads
          : 1;

    // Resource-aware scaling: check available RAM (skip in test env to avoid mocking issues)
    if (this.config.workerThreads === 'auto' && !isTestEnv()) {
      // Jina model typically requires ~1.5GB - 2GB per worker
      const freeMemGb = os.freemem() / 1024 / 1024 / 1024;
      const isHeavyModel = this.config.embeddingModel.includes('jina');
      const memPerWorker = isHeavyModel ? 2.0 : 0.8;

      const memCappedWorkers = Math.max(1, Math.floor(freeMemGb / memPerWorker));
      if (memCappedWorkers < numWorkers) {
        if (this.config.verbose) {
          console.info(
            `[Indexer] Throttling workers from ${numWorkers} to ${memCappedWorkers} due to available RAM (${freeMemGb.toFixed(1)}GB)`
          );
        }
        numWorkers = memCappedWorkers;
      }
    }

    // Use workers even for single worker to benefit from --expose-gc and separate heap
    if (numWorkers < 1) {
      console.info('[Indexer] No workers configured, using main thread (warning: higher RAM usage)');
      return;
    }

    if (this.config.verbose) {
      console.info(
        `[Indexer] Worker config: workerThreads=${this.config.workerThreads}, resolved to ${numWorkers}`
      );
    }

    // Force 1 thread per worker to prevent CPU saturation (ONNX is very aggressive)
    const threadsPerWorker = 1;

    console.info(`[Indexer] Initializing ${numWorkers} worker threads (${threadsPerWorker} threads per worker)...`);

    const workerPath = path.join(__dirname, '../lib/embedding-worker.js');

    for (let i = 0; i < numWorkers; i++) {
      try {
        const worker = new Worker(workerPath, {
          workerData: {
            workerId: i,
            embeddingModel: this.config.embeddingModel,
            verbose: this.config.verbose,
            numThreads: threadsPerWorker,
          },
        });

        const readyPromise = new Promise((resolve, reject) => {
          const readyTimeoutMs = isTestEnv() ? 1000 : 120000;
          const timeout = setTimeout(
            () => reject(new Error('Worker init timeout')),
            readyTimeoutMs
          );

          worker.once('message', (msg) => {
            clearTimeout(timeout);
            if (msg.type === 'ready') {
              resolve(worker);
            } else if (msg.type === 'error') {
              console.warn(`[Indexer] Worker initialization failed: ${msg.error}`);
              if (!isTestEnv()) {
                console.error(`[Indexer] Worker initialization failed: ${msg.error}`);
              }
              reject(new Error(msg.error));
            }
          });

          worker.once('error', (err) => {
            clearTimeout(timeout);
            console.warn(`[Indexer] Worker initialization failed: ${err.message}`);
            if (!isTestEnv()) {
              console.error(`[Indexer] Worker initialization failed: ${err.message}`);
            }
            reject(err);
          });
        });

        this.workers.push(worker);
        this.workerReady.push(readyPromise);
      } catch (err) {
        console.warn(`[Indexer] Failed to create worker ${i}: ${err.message}`);
        if (!isTestEnv()) {
          console.error(`[Indexer] Failed to create worker ${i}: ${err.message}`);
        }
      }
    }

    // Wait for all workers to be ready
    try {
      await Promise.all(this.workerReady);
      console.info(`[Indexer] ${this.workers.length} workers ready`);
      if (this.config.verbose) {
        console.info(`[Indexer] Each worker loaded model: ${this.config.embeddingModel}`);
      }
    } catch (err) {
      console.warn(
        `[Indexer] Worker initialization failed: ${err.message}, falling back to single-threaded`
      );
      if (!isTestEnv()) {
        console.error(
          `[Indexer] Worker initialization failed: ${err.message}, falling back to single-threaded`
        );
      }
      await this.terminateWorkers();
    }
  }

  /**
   * Terminate all worker threads
   */
  async terminateWorkers() {
    const WORKER_SHUTDOWN_TIMEOUT = isTestEnv() ? 50 : 5000;
    const terminations = this.workers.map((worker) => {
      try {
        worker.postMessage({ type: 'shutdown' });
      } catch { /* ignore */ }

      let exited = false;
      const exitPromise = new Promise((resolve) => {
        worker.once('exit', () => {
          exited = true;
          resolve();
        });
      });
      const timeoutPromise = delay(WORKER_SHUTDOWN_TIMEOUT);

      return Promise.race([exitPromise, timeoutPromise]).then(() => {
        if (!exited) {
          const termination = worker.terminate?.();
          return Promise.resolve(termination).catch(() => null);
        }
        return null;
      });
    });
    await Promise.all(terminations);
    this.workers = [];
    this.workerReady = [];
  }

  isExcluded(filePath) {
    return matchesExcludePatterns(filePath, this.excludeMatchers);
  }

  /**
   * Send MCP progress notification to connected clients
   */
  sendProgress(progress, total, message) {
    if (this.server) {
      try {
        this.server.sendNotification('notifications/progress', {
          progressToken: 'indexing',
          progress,
          total,
          message,
        });
      } catch (_err) {
        // Silently ignore if client doesn't support progress notifications
      }
    }
  }

  /**
   * Process chunks using worker thread pool with timeout and error recovery
   */
  async processChunksWithWorkers(allChunks) {
    if (this.workers.length === 0) {
      // Fallback to single-threaded processing
      return this.processChunksSingleThreaded(allChunks);
    }

    const results = [];
    const chunkSize = Math.ceil(allChunks.length / this.workers.length);
    const workerPromises = [];
    const WORKER_TIMEOUT = isTestEnv() ? 1000 : 300000; // 1s in tests, 5 minutes in prod

    if (this.config.verbose) {
      console.info(
        `[Indexer] Distributing ${allChunks.length} chunks across ${this.workers.length} workers (~${chunkSize} chunks each)`
      );
    }

    for (let i = 0; i < this.workers.length; i++) {
      const workerChunks = allChunks.slice(i * chunkSize, (i + 1) * chunkSize);
      if (workerChunks.length === 0) continue;

      if (this.config.verbose) {
        console.info(`[Indexer] Worker ${i}: processing ${workerChunks.length} chunks`);
      }

      const promise = new Promise((resolve, _reject) => {
        const worker = this.workers[i];
        const batchId = `batch-${i}-${Date.now()}`;
        const batchResults = [];

        // Timeout handler
        let timeout = setTimeout(() => {
          worker.off('message', handler);
          worker.off('error', errorHandler);
          console.warn(
            `[Indexer] Worker ${i} timed out, falling back to single-threaded for this batch`
          );
          // Return empty and let fallback handle it
          resolve([]);
        }, WORKER_TIMEOUT);

        const resetTimeout = () => {
          clearTimeout(timeout);
          timeout = setTimeout(() => {
            worker.off('message', handler);
            worker.off('error', errorHandler);
            console.warn(
              `[Indexer] Worker ${i} timed out, falling back to single-threaded for this batch`
            );
            resolve([]);
          }, WORKER_TIMEOUT);
        };

        const finalize = (results) => {
          clearTimeout(timeout);
          worker.off('message', handler);
          worker.off('error', errorHandler);
          resolve(results);
        };

        const handler = (msg) => {
          if (msg.batchId === batchId) {
            resetTimeout();
            if (msg.type === 'results') {
              if (Array.isArray(msg.results) && msg.results.length > 0) {
                batchResults.push(...msg.results);
              }
              if (msg.done === false) {
                return;
              }
              finalize(batchResults);
            } else if (msg.type === 'error') {
              console.warn(`[Indexer] Worker ${i} error: ${msg.error}`);
              if (!isTestEnv()) {
                console.error(`[Indexer] Worker ${i} error: ${msg.error}`);
              }
              finalize([]); // Return empty, don't reject - let fallback handle
            }
          }
        };

        // Handle worker crash
        const errorHandler = (err) => {
          console.warn(`[Indexer] Worker ${i} crashed: ${err.message}`);
          finalize([]); // Return empty, don't reject
        };
        worker.once('error', errorHandler);

        worker.on('message', handler);
        try {
          worker.postMessage({ type: 'process', chunks: workerChunks, batchId });
        } catch (error) {
          console.warn(`[Indexer] Worker ${i} postMessage failed: ${error.message}`);
          finalize([]);
        }
      });

      workerPromises.push({ promise, chunks: workerChunks });
    }

    // Wait for all workers with error recovery
    const workerResults = await Promise.all(workerPromises.map((p) => p.promise));

    // Collect results and identify failed chunks that need retry
    const failedChunks = [];
    for (let i = 0; i < workerResults.length; i++) {
      if (workerResults[i].length > 0) {
        results.push(...workerResults[i]);
      } else if (workerPromises[i].chunks.length > 0) {
        // Worker failed or timed out, need to retry these chunks
        failedChunks.push(...workerPromises[i].chunks);
      }
    }

    // Retry failed chunks with single-threaded fallback
    if (failedChunks.length > 0) {
      console.warn(
        `[Indexer] Retrying ${failedChunks.length} chunks with single-threaded fallback...`
      );
      const retryResults = await this.processChunksSingleThreaded(failedChunks);
      results.push(...retryResults);
    }

    return results;
  }

  /**
   * Single-threaded chunk processing (fallback)
   */
  async processChunksSingleThreaded(chunks) {
    const results = [];

    // Manual GC and yield loop to prevent CPU lockup
    let processedSinceGc = 0;
    
    for (const chunk of chunks) {
      // Throttle speed (balanced)
      await delay(10);

      try {
          const output = await this.embedder(chunk.text, {
            pooling: 'mean',
            normalize: true,
          });
          results.push({
            file: chunk.file,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content: chunk.text,
            vector: toFloat32Array(output.data),
            success: true,
          });

          // Periodic GC to prevent memory creep (only if flag is present)
          processedSinceGc++;
          if (processedSinceGc >= 50 && typeof global.gc === 'function') { 
            global.gc();
            processedSinceGc = 0;
          }

      } catch (error) {
        results.push({
          file: chunk.file,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          error: error.message,
          success: false,
        });
      }
    }

    return results;
  }

  async indexFile(file) {
    const fileName = path.basename(file);
    if (this.isExcluded(file)) {
      if (this.config.verbose) {
        console.info(`[Indexer] Skipped ${fileName} (excluded by pattern)`);
      }
      return 0;
    }
    if (this.config.verbose) {
      console.info(`[Indexer] Processing: ${fileName}...`);
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
          console.warn(
            `[Indexer] Skipped ${fileName} (too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB)`
          );
          if (!isTestEnv()) {
            console.error(
              `[Indexer] Skipped ${fileName} (too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB)`
            );
          }
        }
        return 0;
      }

      const content = await fs.readFile(file, 'utf-8');
      const hash = hashContent(content);

      // Skip if file hasn't changed
      if (this.cache.getFileHash(file) === hash) {
        if (this.config.verbose) {
          console.info(`[Indexer] Skipped ${fileName} (unchanged)`);
        }
        // Still update metadata (size, mtime) even if hash is same
        this.cache.setFileHash(file, hash, stats);
        return 0;
      }

      if (this.config.verbose) {
        console.info(`[Indexer] Indexing ${fileName}...`);
      }

      // Clear existing hash so failed reindex doesn't leave stale hash pointing to removed chunks
      this.cache.deleteFileHash(file);
      // Remove old chunks for this file
      this.cache.removeFileFromStore(file);

      // Extract call graph data if enabled
      if (this.config.callGraphEnabled) {
        try {
          const callData = extractCallData(content, file);
          this.cache.setFileCallData(file, callData);
        } catch (err) {
          if (this.config.verbose) {
            console.warn(
              `[Indexer] Call graph extraction failed for ${fileName}: ${err.message}`
            );
          }
        }
      }

      const chunks = smartChunk(content, file, this.config);
      let addedChunks = 0;
      let failedChunks = 0;
      const totalChunks = chunks.length;

      for (const chunk of chunks) {
        try {
          const output = await this.embedder(chunk.text, {
            pooling: 'mean',
            normalize: true,
          });

          this.cache.addToStore({
            file,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content: chunk.text,
            vector: toFloat32Array(output.data),
          });
          addedChunks++;
        } catch (embeddingError) {
          failedChunks++;
          console.warn(`[Indexer] Failed to embed chunk in ${fileName}:`, embeddingError.message);
        }
      }

      if (totalChunks === 0 || failedChunks === 0) {
        this.cache.setFileHash(file, hash);
      } else if (this.config.verbose) {
        console.warn(
          `[Indexer] Skipped hash update for ${fileName} (${addedChunks}/${totalChunks} chunks embedded)`
        );
      }
      if (this.config.verbose) {
        console.info(`[Indexer] Completed ${fileName} (${addedChunks} chunks)`);
      }
      return addedChunks;
    } catch (error) {
      if (this.config.verbose) {
        console.warn(`[Indexer] Error indexing ${fileName}:`, error.message);
      }
      if (!isTestEnv()) {
        console.error(`[Indexer] Error indexing ${fileName}:`, error.message);
      }
      return 0;
    }
  }

  /**
   * Discover files using fdir (3-5x faster than glob)
   * Uses config.excludePatterns which includes smart patterns from ignore-patterns.js
   */
  async discoverFiles() {
    const startTime = Date.now();

    // Build extension filter from config
    const extensions = new Set(this.config.fileExtensions.map((ext) => `.${ext}`));
    const allowedFileNames = new Set(this.config.fileNames || []);

    // Extract directory names from glob patterns in config.excludePatterns
    // Patterns like "**/node_modules/**" -> "node_modules"
    const excludeDirs = new Set();
    for (const pattern of this.config.excludePatterns) {
      // Extract directory names from glob patterns
      const match = pattern.match(/\*\*\/([^/*]+)\/?\*?\*?$/);
      if (match) {
        excludeDirs.add(match[1]);
      }
      // Also handle patterns like "**/dirname/**"
      const match2 = pattern.match(/\*\*\/([^/*]+)\/\*\*$/);
      if (match2) {
        excludeDirs.add(match2[1]);
      }
    }

    // Always exclude cache directory
    excludeDirs.add('.smart-coding-cache');

    if (this.config.verbose) {
      console.info(`[Indexer] Using ${excludeDirs.size} exclude directories from config`);
    }

    const api = new fdir()
      .withFullPaths()
      .exclude((dirName) => excludeDirs.has(dirName))
      .filter(
        (filePath) =>
          (extensions.has(path.extname(filePath)) ||
            allowedFileNames.has(path.basename(filePath))) &&
          !this.isExcluded(filePath)
      )
      .crawl(this.config.searchDirectory);

    const files = await api.withPromise();

    console.info(`[Indexer] File discovery: ${files.length} files in ${Date.now() - startTime}ms`);
    return files;
  }

  /**
   * Pre-filter files by hash (skip unchanged files before processing)
   */
  async preFilterFiles(files) {
    const startTime = Date.now();
    const filesToProcess = [];
    const skippedCount = { unchanged: 0, tooLarge: 0, error: 0 };

    // Process in parallel batches for speed
    // We fetch stats for 100 files at a time to keep IO efficient
    const STAT_BATCH_SIZE = Math.min(100, this.config.batchSize || 100);
    // Limit concurrent file reads to 50MB to prevent OOM
    const MAX_READ_BATCH_BYTES = 50 * 1024 * 1024;

    for (let i = 0; i < files.length; i += STAT_BATCH_SIZE) {
      const batchFiles = files.slice(i, i + STAT_BATCH_SIZE);

      // 1. Get stats for all files in this batch parallel
      const fileStats = await Promise.all(
        batchFiles.map(async (file) => {
          try {
            const stats = await fs.stat(file);

            if (stats.isDirectory()) {
              return null;
            }

            if (stats.size > this.config.maxFileSize) {
              skippedCount.tooLarge++;
              return null;
            }

            return { file, size: stats.size, mtimeMs: stats.mtimeMs };
          } catch (_err) {
            skippedCount.error++;
            return null;
          }
        })
      );

      // 2. Process valid files in size-constrained sub-batches
      let currentReadBatch = [];
      let currentReadBytes = 0;

      const processReadBatch = async (batch) => {
        const results = await Promise.all(
          batch.map(async ({ file }) => {
            try {
              const content = await fs.readFile(file, 'utf-8');
              const hash = hashContent(content);

              if (this.cache.getFileHash(file) === hash) {
                skippedCount.unchanged++;
                return null;
              }

              return { file, hash, force: false };
            } catch (_err) {
              skippedCount.error++;
              return null;
            }
          })
        );

        for (const result of results) {
          if (result) filesToProcess.push(result);
        }
      };

      for (const item of fileStats) {
        if (!item) continue;

        if (
          currentReadBytes + item.size > MAX_READ_BATCH_BYTES &&
          currentReadBatch.length > 0
        ) {
          await processReadBatch(currentReadBatch);
          currentReadBatch = [];
          currentReadBytes = 0;
        }

        currentReadBatch.push(item);
        currentReadBytes += item.size;
      }

      if (currentReadBatch.length > 0) {
        await processReadBatch(currentReadBatch);
      }
      
      // Pre-warm HybridSearch cache if available
      if (this.server && this.server.hybridSearch && this.server.hybridSearch.fileModTimes) {
          for (const stat of fileStats) {
            if (stat && stat.file && typeof stat.mtimeMs === 'number') {
              this.server.hybridSearch.fileModTimes.set(stat.file, stat.mtimeMs);
            }
          }
      }
    }

    if (this.config.verbose) {
       console.info(
        `[Indexer] Pre-filter: ${filesToProcess.length} changed, ${skippedCount.unchanged} unchanged, ${skippedCount.tooLarge} too large, ${skippedCount.error} errors (${Date.now() - startTime}ms)`
      );
    }
    

    
    return filesToProcess;
  }

  async indexAll(force = false) {
    if (this.isIndexing || this.processingWatchEvents) {
      console.warn('[Indexer] Indexing already in progress, skipping concurrent request');
      return {
        skipped: true,
        reason: 'Indexing already in progress or pending file updates are being applied',
      };
    }

    this.isIndexing = true;
    let memoryTimer = null;
    const logMemory = (label) => {
      if (!this.config.verbose) return;
      const { rss, heapUsed, heapTotal } = process.memoryUsage();
      const toMb = (value) => `${(value / 1024 / 1024).toFixed(1)}MB`;
      console.info(
        `[Indexer] Memory ${label}: rss=${toMb(rss)} heap=${toMb(heapUsed)}/${toMb(heapTotal)}`,
      );
    };

    try {
      logMemory('start');
      if (this.config.verbose) {
        memoryTimer = setInterval(() => logMemory('periodic'), 15000);
      }

      if (force) {
        console.info('[Indexer] Force reindex requested: clearing cache');
        this.cache.setVectorStore([]);
        this.cache.fileHashes = new Map();
        await this.cache.clearCallGraphData({ removeFile: true });
      }

      const totalStartTime = Date.now();
        console.info(`[Indexer] Starting optimized indexing in ${this.config.searchDirectory}...`);

      // Step 1: Fast file discovery with fdir
      const files = await this.discoverFiles();

      if (files.length === 0) {
        console.info('[Indexer] No files found to index');
        this.sendProgress(100, 100, 'No files found to index');
        return {
          skipped: false,
          filesProcessed: 0,
          chunksCreated: 0,
          message: 'No files found to index',
        };
      }

      // Send progress: discovery complete
      this.sendProgress(5, 100, `Discovered ${files.length} files`);

      const currentFilesSet = new Set(files);

      // Step 1.5: Prune deleted or excluded files from cache
      if (!force) {
        const cachedFiles = Array.from(this.cache.fileHashes.keys());
        let prunedCount = 0;

        for (const cachedFile of cachedFiles) {
          if (!currentFilesSet.has(cachedFile)) {
            this.cache.removeFileFromStore(cachedFile);
            this.cache.deleteFileHash(cachedFile);
            prunedCount++;
          }
        }

        if (prunedCount > 0) {
          if (this.config.verbose) {
            console.info(`[Indexer] Pruned ${prunedCount} deleted/excluded files from index`);
            console.error(`[Indexer] Pruned ${prunedCount} deleted/excluded files from index`);
          }
          // If we pruned files, we should save these changes even if no other files changed
        }

        const prunedCallGraph = this.cache.pruneCallGraphData(currentFilesSet);
        if (prunedCallGraph > 0 && this.config.verbose) {
          console.info(`[Indexer] Pruned ${prunedCallGraph} call-graph entries`);
          console.error(`[Indexer] Pruned ${prunedCallGraph} call-graph entries`);
        }
      }

      // Step 2: Pre-filter unchanged files (early hash check)
      const filesToProcess = await this.preFilterFiles(files);
      const filesToProcessSet = new Set(filesToProcess.map((entry) => entry.file));

      if (filesToProcess.length === 0) {
        console.info('[Indexer] All files unchanged, nothing to index');

        // If we have no call graph data but we have cached files, we should try to rebuild it
        if (this.config.callGraphEnabled && this.cache.getVectorStore().length > 0) {
          // Check for files that are in cache but missing from call graph data
          const cachedFiles = new Set(this.cache.getVectorStore().map((c) => c.file));
          const callDataFiles = new Set(this.cache.fileCallData.keys());

          const missingCallData = [];
          for (const file of cachedFiles) {
            if (!callDataFiles.has(file) && currentFilesSet.has(file)) {
              missingCallData.push(file);
            }
          }

          if (missingCallData.length > 0) {
            console.info(
              `[Indexer] Found ${missingCallData.length} files missing call graph data, re-indexing...`
            );
            console.error(
              `[Indexer] Found ${missingCallData.length} files missing call graph data, re-indexing...`
            );
            const BATCH_SIZE = 100;
            for (let i = 0; i < missingCallData.length; i += BATCH_SIZE) {
              const batch = missingCallData.slice(i, i + BATCH_SIZE);
              const results = await Promise.all(
                batch.map(async (file) => {
                  try {
                    const stats = await fs.stat(file);
                    if (!stats || typeof stats.isDirectory !== 'function') {
                      return null;
                    }
                    if (stats.isDirectory()) return null;
                    if (stats.size > this.config.maxFileSize) return null;
                    const content = await fs.readFile(file, 'utf-8');
                    const hash = hashContent(content);
                    return { file, hash, force: true };
                  } catch {
                    return null;
                  }
                })
              );

              for (const result of results) {
                if (!result) continue;
                filesToProcess.push(result);
                filesToProcessSet.add(result.file);
              }
            }
          }
        }

        // If still empty after checking for missing call data, then we are truly done
        if (filesToProcess.length === 0) {
          this.sendProgress(100, 100, 'All files up to date');
          await this.cache.save();
          const vectorStore = this.cache.getVectorStore();
          return {
            skipped: false,
            filesProcessed: 0,
            chunksCreated: 0,
            totalFiles: new Set(vectorStore.map((v) => v.file)).size,
            totalChunks: vectorStore.length,
            message: 'All files up to date',
          };
        }
      }

      // Send progress: filtering complete
      this.sendProgress(10, 100, `Processing ${filesToProcess.length} changed files`);

      // Step 3: Determine batch size based on project size
      // Adaptive batch size: use larger batches for larger projects to reduce overhead
      let adaptiveBatchSize = 10;
      if (files.length > 500) adaptiveBatchSize = 50;
      if (files.length > 1000) adaptiveBatchSize = 100;
      if (files.length > 5000) adaptiveBatchSize = 500;

      if (this.config.verbose) {
        console.info(
          `[Indexer] Processing ${filesToProcess.length} files (batch size: ${adaptiveBatchSize})`
        );
      }

      // Step 4: Initialize worker threads (skip if explicitly disabled)
      const useWorkers = os.cpus().length > 1 && this.config.workerThreads !== 0;

      if (useWorkers) {
        await this.initializeWorkers();
        if (this.config.verbose && this.workers.length > 0) {
          console.info(`[Indexer] Multi-threaded mode: ${this.workers.length} workers active`);
        }
      } else if (this.config.verbose) {
        console.info(`[Indexer] Single-threaded mode (single-core system)`);
      }

      let totalChunks = 0;
      let processedFiles = 0;

      if (this.config.verbose) {
        console.info(
          `[Indexer] Embedding pass started: ${filesToProcess.length} files using ${this.config.embeddingModel}`
        );
      }

      // Step 5: Process files in adaptive batches
      for (let i = 0; i < filesToProcess.length; i += adaptiveBatchSize) {
        const batch = filesToProcess.slice(i, i + adaptiveBatchSize);

        // Generate all chunks for this batch
        const allChunks = [];
        const fileStats = new Map();

        // Memory safeguard: check if we are running hot
        const mem = process.memoryUsage();
        if (mem.rss > 2048 * 1024 * 1024) { // > 2GB
           if (global.gc) {
               console.info('[Indexer] Memory high (>2GB), forcing GC...');
               global.gc();
           } else if (this.config.verbose) {
               console.info(`[Indexer] Memory high (>2GB): ${Math.round(mem.rss/1024/1024)}MB`);
           }
           // Optimization: could reduce batch size dynamically here
        }

        for (const { file, force, content: presetContent, hash: presetHash } of batch) {
          let content = presetContent;
          let liveHash = presetHash;

          if (content !== undefined && content !== null) {
            if (typeof content !== 'string') {
              content = String(content);
            }
            if (!liveHash) {
              liveHash = hashContent(content);
            }
            const byteSize = Buffer.byteLength(content, 'utf8');
            if (byteSize > this.config.maxFileSize) {
              if (this.config.verbose) {
                console.warn(
                  `[Indexer] Skipped ${path.basename(file)} (too large: ${(byteSize / 1024 / 1024).toFixed(2)}MB)`,
                );
                console.error(
                  `[Indexer] Skipped ${path.basename(file)} (too large: ${(byteSize / 1024 / 1024).toFixed(2)}MB)`,
                );
              }
              continue;
            }
          } else {
            let stats;
            try {
              stats = await fs.stat(file);
          } catch (err) {
            if (this.config.verbose) {
              console.warn(
                `[Indexer] Failed to stat ${path.basename(file)}: ${err.message}`,
              );
              console.error(
                `[Indexer] Failed to stat ${path.basename(file)}: ${err.message}`,
              );
            }
            continue;
          }

            if (!stats || typeof stats.isDirectory !== 'function') {
              if (this.config.verbose) {
                console.warn(
                  `[Indexer] Invalid stat result for ${path.basename(file)}`,
                );
              }
              continue;
            }

            if (stats.isDirectory()) {
              continue;
            }

            if (stats.size > this.config.maxFileSize) {
              if (this.config.verbose) {
                console.warn(
                  `[Indexer] Skipped ${path.basename(file)} (too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB)`,
                );
              }
              continue;
            }

            try {
              content = await fs.readFile(file, 'utf-8');
            } catch (err) {
              if (this.config.verbose) {
                console.warn(
                  `[Indexer] Failed to read ${path.basename(file)}: ${err.message}`,
                );
              }
              continue;
            }

            liveHash = hashContent(content);
          }

          if (!force && liveHash && this.cache.getFileHash(file) === liveHash) {
            if (this.config.verbose) {
              console.info(`[Indexer] Skipped ${path.basename(file)} (unchanged)`);
            }
            continue;
          }

          // Clear existing hash so failed reindex doesn't leave stale hash pointing to removed chunks
          this.cache.deleteFileHash(file);
          // Remove old chunks for this file
          this.cache.removeFileFromStore(file);

          // Extract call graph data if enabled
          if (this.config.callGraphEnabled) {
            try {
              const callData = extractCallData(content, file);
              this.cache.setFileCallData(file, callData);
            } catch (err) {
              if (this.config.verbose) {
                console.warn(
                  `[Indexer] Call graph extraction failed for ${path.basename(file)}: ${err.message}`
                );
              }
            }
          }

          const chunks = smartChunk(content, file, this.config);
          fileStats.set(file, { hash: liveHash, totalChunks: 0, successChunks: 0 });

          for (const chunk of chunks) {
            allChunks.push({
              file,
              text: chunk.text,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
            });
            const stats = fileStats.get(file);
            if (stats) {
              stats.totalChunks++;
            }
          }
        }

        // Process chunks (with workers if available, otherwise single-threaded)
        let results;
        if (useWorkers && this.workers.length > 0) {
          results = await this.processChunksWithWorkers(allChunks);
        } else {
          results = await this.processChunksSingleThreaded(allChunks);
        }

        // Store successful results
        for (const result of results) {
          const stats = fileStats.get(result.file);
          if (result.success) {
            this.cache.addToStore({
              file: result.file,
              startLine: result.startLine,
              endLine: result.endLine,
              content: result.content,
              vector: result.vector,
            });
            totalChunks++;
            if (stats) {
              stats.successChunks++;
            }
          }
        }

        // Update file hashes
        for (const [file, stats] of fileStats) {
          if (stats.totalChunks === 0 || stats.successChunks === stats.totalChunks) {
            this.cache.setFileHash(file, stats.hash);
          } else if (this.config.verbose) {
            console.warn(
              `[Indexer] Skipped hash update for ${path.basename(file)} (${stats.successChunks}/${stats.totalChunks} chunks embedded)`
            );
          }
        }

        // Clean up memory after each batch (Main Process)
        if (global.gc) {
          global.gc();
        }

        processedFiles += batch.length;

        // Progress indicator every batch
        if (
          processedFiles % (adaptiveBatchSize * 2) === 0 ||
          processedFiles === filesToProcess.length
        ) {
          const elapsed = ((Date.now() - totalStartTime) / 1000).toFixed(1);
          const rate = (processedFiles / parseFloat(elapsed)).toFixed(1);
          console.info(
            `[Indexer] Progress: ${processedFiles}/${filesToProcess.length} files (${rate} files/sec, ${elapsed}s elapsed)`
          );

          // Send MCP progress notification (10-95% range for batch processing)
          const progressPercent = Math.floor(10 + (processedFiles / filesToProcess.length) * 85);
          this.sendProgress(
            progressPercent,
            100,
            `Indexed ${processedFiles}/${filesToProcess.length} files (${rate}/sec)`
          );
        }
      }

      // Cleanup workers
      if (useWorkers) {
        await this.terminateWorkers();
      }

      const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(1);
      console.info(
        `[Indexer] Embedding pass complete: ${totalChunks} chunks from ${filesToProcess.length} files in ${totalTime}s`
      );

      // Send completion progress
      this.sendProgress(
        100,
        100,
        `Complete: ${totalChunks} chunks from ${filesToProcess.length} files in ${totalTime}s`
      );

      await this.cache.save();

      // Rebuild call graph in background
      if (this.config.callGraphEnabled) {
        this.cache.rebuildCallGraph();
      }

      void this.cache.ensureAnnIndex().catch((error) => {
        if (this.config.verbose) {
          console.warn(`[ANN] Background ANN build failed: ${error.message}`);
        }
      });

      const vectorStore = this.cache.getVectorStore();
      return {
        skipped: false,
        filesProcessed: filesToProcess.length,
        chunksCreated: totalChunks,
        totalFiles: new Set(vectorStore.map((v) => v.file)).size,
        totalChunks: vectorStore.length,
        duration: totalTime,
        message: `Indexed ${filesToProcess.length} files (${totalChunks} chunks) in ${totalTime}s`,
      };
    } finally {
      if (memoryTimer) {
        clearInterval(memoryTimer);
      }
      logMemory('end');
      this.isIndexing = false;
      try {
        await this.processPendingWatchEvents();
      } catch (error) {
      console.warn(`[Indexer] Failed to apply queued file updates: ${error.message}`);
    }
  }
  }

  enqueueWatchEvent(type, filePath) {
    const existing = this.pendingWatchEvents.get(filePath);

    // If it's a delete, it always wins
    if (type === 'unlink') {
      this.pendingWatchEvents.set(filePath, 'unlink');
      return;
    }

    // If we're adding/changing, it overwrites a potential unlink (file came back)
    this.pendingWatchEvents.set(filePath, type);
  }

  async processPendingWatchEvents() {
    if (this.processingWatchEvents || this.pendingWatchEvents.size === 0) {
      return;
    }

    this.processingWatchEvents = true;
    try {
      while (this.pendingWatchEvents.size > 0) {
        const pending = Array.from(this.pendingWatchEvents.entries());
        this.pendingWatchEvents.clear();

        for (const [filePath, type] of pending) {
          if (this.server && this.server.hybridSearch) {
            this.server.hybridSearch.clearFileModTime(filePath);
          }

          if (type === 'unlink') {
            this.cache.removeFileFromStore(filePath);
            this.cache.deleteFileHash(filePath);
          } else {
            await this.indexFile(filePath);
          }
        }

        await this.cache.save();
      }
    } finally {
      this.processingWatchEvents = false;
    }
  }

  async setupFileWatcher() {
    if (!this.config.watchFiles) return;

    // Close existing watcher if active to prevent leaks
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    const pattern = [
      ...this.config.fileExtensions.map((ext) => `**/*.${ext}`),
      ...(this.config.fileNames || []).map((name) => `**/${name}`),
    ];

    this.watcher = chokidar.watch(pattern, {
      cwd: this.config.searchDirectory,
      ignored: this.config.excludePatterns,
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher
      .on('add', async (filePath) => {
        const fullPath = path.join(this.config.searchDirectory, filePath);
        console.info(`[Indexer] New file detected: ${filePath}`);

        if (this.isIndexing || this.processingWatchEvents) {
          if (this.config.verbose) {
            console.info(`[Indexer] Queued add event during indexing: ${filePath}`);
          }
          this.enqueueWatchEvent('add', fullPath);
          return;
        }

        // Invalidate recency cache
        if (this.server && this.server.hybridSearch) {
          this.server.hybridSearch.clearFileModTime(fullPath);
        }

        await this.indexFile(fullPath);
        await this.cache.save();
      })
      .on('change', async (filePath) => {
        const fullPath = path.join(this.config.searchDirectory, filePath);
        console.info(`[Indexer] File changed: ${filePath}`);

        if (this.isIndexing || this.processingWatchEvents) {
          if (this.config.verbose) {
            console.info(`[Indexer] Queued change event during indexing: ${filePath}`);
          }
          this.enqueueWatchEvent('change', fullPath);
          return;
        }

        // Invalidate recency cache
        if (this.server && this.server.hybridSearch) {
          this.server.hybridSearch.clearFileModTime(fullPath);
        }

        await this.indexFile(fullPath);
        await this.cache.save();
      })
      .on('unlink', async (filePath) => {
        const fullPath = path.join(this.config.searchDirectory, filePath);
        console.info(`[Indexer] File deleted: ${filePath}`);

        if (this.isIndexing || this.processingWatchEvents) {
          if (this.config.verbose) {
            console.info(`[Indexer] Queued delete event during indexing: ${filePath}`);
          }
          this.enqueueWatchEvent('unlink', fullPath);
          return;
        }

        // Invalidate recency cache
        if (this.server && this.server.hybridSearch) {
          this.server.hybridSearch.clearFileModTime(fullPath);
        }

        this.cache.removeFileFromStore(fullPath);
        this.cache.deleteFileHash(fullPath);
        await this.cache.save();
      });

    console.info('[Indexer] File watcher enabled for incremental indexing');
  }
}

// MCP Tool definition for this feature
export function getToolDefinition() {
  return {
    name: 'b_index_codebase',
    description:
      'Manually trigger a full reindex of the codebase. This will scan all files and update the embeddings cache. Useful after large code changes or if the index seems out of date.',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: "Force reindex even if files haven't changed",
          default: false,
        },
      },
    },
    annotations: {
      title: 'Reindex Codebase',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

// Tool handler
export async function handleToolCall(request, indexer) {
  const force = request.params.arguments?.force || false;
  const result = await indexer.indexAll(force);

  // Handle case when indexing was skipped due to concurrent request
  if (result?.skipped) {
    return {
      content: [
        {
          type: 'text',
          text: `Indexing skipped: ${result.reason}\n\nPlease wait for the current indexing operation to complete before requesting another reindex.`,
        },
      ],
    };
  }

  // Get current stats from cache
  const vectorStore = indexer.cache.getVectorStore();
  const stats = {
    totalChunks: result?.totalChunks ?? vectorStore.length,
    totalFiles: result?.totalFiles ?? new Set(vectorStore.map((v) => v.file)).size,
    filesProcessed: result?.filesProcessed ?? 0,
    chunksCreated: result?.chunksCreated ?? 0,
  };

  let message = result?.message
    ? `Codebase reindexed successfully.\n\n${result.message}`
    : `Codebase reindexed successfully.`;

  message += `\n\nStatistics:\n- Total files in index: ${stats.totalFiles}\n- Total code chunks: ${stats.totalChunks}`;

  if (stats.filesProcessed > 0) {
    message += `\n- Files processed this run: ${stats.filesProcessed}\n- Chunks created this run: ${stats.chunksCreated}`;
  }

  return {
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
  };
}
