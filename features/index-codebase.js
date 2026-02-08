import { fdir } from 'fdir';
import fs from 'fs/promises';
import chokidar from 'chokidar';
import path from 'path';
import os from 'os';
import { Worker } from 'worker_threads';
import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath } from 'url';
import { smartChunk, hashContent } from '../lib/utils.js';
import { extractCallData } from '../lib/call-graph.js';

import ignore from 'ignore';

import { sliceAndNormalize, toFloat32Array } from '../lib/slice-normalize.js';
import {
  MAX_PENDING_WATCH_EVENTS,
  PENDING_WATCH_EVENTS_TRIM_SIZE,
} from '../lib/constants.js';

function isTestEnv() {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
}

function normalizePath(value) {
  if (typeof value !== 'string') return '';
  return value.split(path.sep).join('/');
}

function globToRegExp(pattern) {
  let regex = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          regex += '(?:.*/)?';
          i += 2;
        } else {
          regex += '.*';
          i += 1;
        }
      } else {
        regex += '[^/]*';
      }
    } else if (char === '?') {
      regex += '[^/]';
    } else if ('\\.[]{}()+-^$|'.includes(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  regex += '$';
  return new RegExp(regex);
}

function buildExcludeMatchers(patterns) {
  if (!Array.isArray(patterns)) return [];
  return patterns
    .filter((pattern) => typeof pattern === 'string' && pattern.length > 0)
    .map((pattern) => {
      const normalized = pattern.replace(/\\/g, '/');
      const matchBase = !normalized.includes('/');
      return {
        pattern: normalized,
        matchBase,
        regex: globToRegExp(normalized),
      };
    });
}

function matchesExcludePatterns(filePath, matchers) {
  if (!filePath || matchers.length === 0) return false;
  const normalized = normalizePath(filePath);
  const base = path.posix.basename(normalized);
  for (const matcher of matchers) {
    const target = matcher.matchBase ? base : normalized;
    if (matcher.regex.test(target)) return true;
  }
  return false;
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
    this.rebuildExcludeMatchers();
    this.gitignore = ignore();
    this.workerFailureCount = 0;
    this.workersDisabledUntil = 0;
    this.workerCircuitOpen = false;
    this._retryTimer = null;
    this._lastProgress = null;
    this.currentIndexMode = null;
    this.workspaceRoot = this.config.searchDirectory
      ? path.resolve(this.config.searchDirectory)
      : null;
    this.workspaceRootReal = null;
    this._lastIncrementalGcAt = 0;
    this._autoEmbeddingProcessLogged = false;
    this._heavyWorkerSafetyLogged = false;
    // Debounce timers for watcher events (path -> timeout ID)
    this._watcherDebounceTimers = new Map();
    // Files currently being indexed via watcher (path -> Promise)
    this._watcherInProgress = new Map();
    // Files that need a follow-up reindex after current watcher indexing finishes
    this._watcherPendingReindex = new Map();
    // Debounce delay in ms (consolidates rapid add/change events)
    this._watcherDebounceMs = Number.isInteger(this.config.watchDebounceMs)
      ? this.config.watchDebounceMs
      : 300;
    // Wait-for-stable writes (chokidar awaitWriteFinish) to reduce add+change churn
    this._watcherWriteStabilityMs = Number.isInteger(this.config.watchWriteStabilityMs)
      ? this.config.watchWriteStabilityMs
      : 1500;
    // Persistent embedding child process (used to avoid per-batch model reloads)
    this._embeddingProcessSessionActive = false;
    this._embeddingChild = null;
    this._embeddingChildBuffer = '';
    this._embeddingChildQueue = [];
    this._embeddingSessionStats = null;
    this._embeddingRequestId = 0;
    this._embeddingChildNeedsRestart = false;
    this._embeddingChildRestartThresholdMb = this.getEmbeddingChildRestartThresholdMb();
    this._embeddingChildStopping = false;
    this._lastExplicitGcAt = 0;
  }

  rebuildExcludeMatchers() {
    const cacheRelative = this.getCacheRelativePath();
    const autoExclude = ['.smart-coding-cache'];
    if (cacheRelative) {
      autoExclude.push(cacheRelative, `${cacheRelative}/**`);
    }
    this.excludeMatchers = buildExcludeMatchers([
      ...autoExclude,
      ...(this.config.excludePatterns || []),
    ]);
  }

  async updateWorkspaceState({ restartWatcher = false } = {}) {
    this.workspaceRoot = this.config.searchDirectory
      ? path.resolve(this.config.searchDirectory)
      : null;
    this.workspaceRootReal = null;
    this.rebuildExcludeMatchers();
    this.gitignore = ignore();
    if (this.pendingWatchEvents) {
      this.pendingWatchEvents.clear();
    }
    if (this._watcherDebounceTimers) {
      for (const timer of this._watcherDebounceTimers.values()) {
        clearTimeout(timer);
      }
      this._watcherDebounceTimers.clear();
    }
    if (this._watcherInProgress) {
      this._watcherInProgress.clear();
    }
    if (this._watcherPendingReindex) {
      this._watcherPendingReindex.clear();
    }

    if (restartWatcher && this.config.watchFiles) {
      await this.setupFileWatcher();
    } else if (this.config.watchFiles) {
      await this.loadGitignore();
    }
  }

  getEmbeddingChildRestartThresholdMb() {
    const totalMb = typeof os.totalmem === 'function' ? os.totalmem() / 1024 / 1024 : 8192;
    if (this.isHeavyEmbeddingModel()) {
      return Math.min(8000, Math.max(6000, totalMb * 0.3));
    }
    return Math.min(5000, Math.max(2500, totalMb * 0.3));
  }

  getEmbeddingProcessConfig() {
    const threads = Number.isInteger(this.config.embeddingProcessNumThreads)
      ? this.config.embeddingProcessNumThreads
      : 8;
    const batchSize =
      Number.isInteger(this.config.embeddingBatchSize) && this.config.embeddingBatchSize > 0
        ? this.config.embeddingBatchSize
        : null;
    return { threads, batchSize };
  }

  isExplicitGcEnabled() {
    return this.config.enableExplicitGc !== false && typeof global.gc === 'function';
  }

  runExplicitGc({ minIntervalMs = 0, force = false } = {}) {
    if (!this.isExplicitGcEnabled()) return false;
    const now = Date.now();
    if (
      !force &&
      minIntervalMs > 0 &&
      this._lastExplicitGcAt &&
      now - this._lastExplicitGcAt < minIntervalMs
    ) {
      return false;
    }
    this._lastExplicitGcAt = now;
    global.gc();
    return true;
  }

  isPathInsideWorkspace(filePath) {
    if (!filePath || !this.workspaceRoot) return true;
    const target = path.resolve(filePath);
    const normalizedBase =
      process.platform === 'win32' ? this.workspaceRoot.toLowerCase() : this.workspaceRoot;
    const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target;
    const rel = path.relative(normalizedBase, normalizedTarget);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  async resolveWorkspaceRealpath() {
    if (!this.workspaceRoot) return null;
    if (this.workspaceRootReal) return this.workspaceRootReal;
    try {
      this.workspaceRootReal = await fs.realpath(this.workspaceRoot);
    } catch {
      this.workspaceRootReal = this.workspaceRoot;
    }
    return this.workspaceRootReal;
  }

  async isPathInsideWorkspaceReal(filePath) {
    if (!filePath || !this.workspaceRoot) return true;
    const baseReal = await this.resolveWorkspaceRealpath();
    try {
      const targetReal = await fs.realpath(filePath);
      const normalizedBase = process.platform === 'win32' ? baseReal.toLowerCase() : baseReal;
      const normalizedTarget = process.platform === 'win32' ? targetReal.toLowerCase() : targetReal;
      const rel = path.relative(normalizedBase, normalizedTarget);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    } catch {
      // Fall back to lexical check when realpath fails (e.g., deleted files).
      return this.isPathInsideWorkspace(filePath);
    }
  }

  maybeResetWorkerCircuit() {
    if (
      this.workerCircuitOpen &&
      this.workersDisabledUntil &&
      Date.now() >= this.workersDisabledUntil
    ) {
      this.workerCircuitOpen = false;
      this.workersDisabledUntil = 0;
      this.workerFailureCount = 0;
      if (this.config.verbose) {
        console.info('[Indexer] Worker circuit closed; resuming worker use');
      }
    }
  }

  shouldUseWorkers() {
    this.maybeResetWorkerCircuit();
    if (this.workersDisabledUntil && Date.now() < this.workersDisabledUntil) {
      return false;
    }
    if (isTestEnv()) return false;
    return (
      os.cpus().length > 1 &&
      this.config.workerThreads !== 0 &&
      !this.config.embeddingProcessPerBatch
    );
  }

  isHeavyEmbeddingModel() {
    const model = String(this.config.embeddingModel || '').toLowerCase();
    return model.includes('jina');
  }

  getWorkerInferenceBatchSize({ numWorkers = null } = {}) {
    const configured =
      Number.isInteger(this.config.embeddingBatchSize) && this.config.embeddingBatchSize > 0
        ? this.config.embeddingBatchSize
        : null;
    if (configured) return Math.min(configured, 256);
    // Heavy models are more stable with batch=1 in multi-worker mode on some runtimes.
    if (this.isHeavyEmbeddingModel() && Number.isInteger(numWorkers) && numWorkers > 1) return 1;
    return null;
  }

  shouldUseEmbeddingProcessPerBatch(useWorkers = null) {
    if (this.config.embeddingProcessPerBatch) return true;
    if (isTestEnv()) return false;
    if (this.config.autoEmbeddingProcessPerBatch === false) return false;
    const workersActive = typeof useWorkers === 'boolean' ? useWorkers : this.shouldUseWorkers();
    if (workersActive) return false;
    if (!this.isHeavyEmbeddingModel()) return false;
    if (!this._autoEmbeddingProcessLogged) {
      console.info(
        '[Indexer] Auto-enabling embeddingProcessPerBatch for memory isolation (set autoEmbeddingProcessPerBatch=false to disable)'
      );
      this._autoEmbeddingProcessLogged = true;
    }
    return true;
  }

  scheduleRetry() {
    if (this._retryTimer || isTestEnv()) return;
    const delayMs = Math.max(1000, this.workersDisabledUntil - Date.now());
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (!this.isIndexing && !this.processingWatchEvents) {
        this.indexAll().catch(() => null);
      }
    }, delayMs);
  }

  maybeRunIncrementalGc(reason) {
    if (!this.config.enableExplicitGc || typeof global.gc !== 'function') return;
    const now = Date.now();
    const minIntervalMs = 60_000;
    if (this._lastIncrementalGcAt && now - this._lastIncrementalGcAt < minIntervalMs) return;
    const thresholdMb = Number.isFinite(this.config.incrementalGcThresholdMb)
      ? this.config.incrementalGcThresholdMb
      : 2048;
    if (thresholdMb <= 0) return;
    const { rss } = process.memoryUsage();
    if (rss < thresholdMb * 1024 * 1024) return;
    if (this.config.verbose) {
      const rssMb = (rss / 1024 / 1024).toFixed(1);
      console.info(
        `[Indexer] Incremental GC (${reason}) rss=${rssMb}MB threshold=${thresholdMb}MB`
      );
    }
    this._lastIncrementalGcAt = now;
    global.gc();
  }

  recordWorkerFailure(reason) {
    const threshold = Number.isInteger(this.config.workerFailureThreshold)
      ? this.config.workerFailureThreshold
      : 1;
    const cooldownMs = Number.isInteger(this.config.workerFailureCooldownMs)
      ? this.config.workerFailureCooldownMs
      : 10 * 60 * 1000;

    this.workerFailureCount += 1;
    console.warn(`[Indexer] Worker failure: ${reason} (${this.workerFailureCount}/${threshold})`);

    if (this.workerFailureCount >= threshold) {
      this.workersDisabledUntil = Date.now() + cooldownMs;
      this.workerCircuitOpen = true;
      console.warn(
        `[Indexer] Worker circuit open; pausing worker use for ${Math.round(cooldownMs / 1000)}s`
      );
      this.scheduleRetry();
    }
  }

  /**
   * Initialize worker thread pool for parallel embedding
   */
  async initializeWorkers() {
    // Check if we have any active workers
    const activeWorkers = this.workers.filter((w) => w !== null);
    if (activeWorkers.length > 0) return;

    // If we have workers array but they are all null, reset it
    if (this.workers.length > 0) {
      this.workers = [];
      this.workerReady = [];
    }

    if (this.initWorkerPromise) return this.initWorkerPromise;

    this.initWorkerPromise = (async () => {
      try {
        let numWorkers =
          this.config.workerThreads === 'auto'
            ? Math.min(2, Math.max(1, os.cpus().length - 1)) // Cap 'auto' at 2 workers
            : typeof this.config.workerThreads === 'number'
              ? this.config.workerThreads
              : 1;

        // Heavy models can consume multiple GB per worker. Keep auto mode bounded by
        // existing memory guards below; do not hard-pin to 1 worker as it can hurt throughput.
        if (process.platform === 'win32' && this.isHeavyEmbeddingModel() && numWorkers > 1) {
          if (!this._heavyWorkerSafetyLogged) {
            console.warn(
              '[Indexer] Heavy model worker safety mode: forcing workers=1 on Windows to avoid native multi-worker crashes'
            );
            this._heavyWorkerSafetyLogged = true;
          }
          numWorkers = 1;
        }

        // Resource-aware scaling: check available RAM (skip in test env to avoid mocking issues)
        // We apply this if we have > 1 worker, regardless of whether it was 'auto' or explicit
        if (numWorkers > 1 && !isTestEnv() && typeof os.freemem === 'function') {
          const freeMemGb = os.freemem() / 1024 / 1024 / 1024;
          const isHeavyModel = this.isHeavyEmbeddingModel();
          const memPerWorker = isHeavyModel ? 8.0 : 0.8;

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

        // Hard memory ceiling: disable workers if projected RSS risks OOM
        if (!isTestEnv() && typeof os.totalmem === 'function') {
          const totalMemGb = os.totalmem() / 1024 / 1024 / 1024;
          const rssGb = process.memoryUsage().rss / 1024 / 1024 / 1024;
          const isHeavyModel = this.isHeavyEmbeddingModel();
          const memPerWorker = isHeavyModel ? 8.0 : 0.8;
          const projectedGb = rssGb + numWorkers * memPerWorker + 0.5; // 0.5GB headroom
          const ceilingGb = totalMemGb * 0.85;
          if (numWorkers > 0 && projectedGb > ceilingGb) {
            if (this.config.verbose) {
              console.info(
                `[Indexer] Disabling workers to avoid OOM: projected=${projectedGb.toFixed(1)}GB ceiling=${ceilingGb.toFixed(1)}GB rss=${rssGb.toFixed(1)}GB total=${totalMemGb.toFixed(1)}GB`
              );
            }
            numWorkers = 0;
          }
        }

        // Use workers even for single worker to benefit from --expose-gc and separate heap
        if (numWorkers < 1) {
          console.info(
            '[Indexer] No workers configured, using main thread (warning: higher RAM usage)'
          );
          return;
        }

        if (this.config.verbose) {
          console.info(
            `[Indexer] Worker config: workerThreads=${this.config.workerThreads}, resolved to ${numWorkers}`
          );
        }

        // Force 1 thread per worker to prevent CPU saturation (ONNX is very aggressive)
        const threadsPerWorker = 1;

        console.info(
          `[Indexer] Initializing ${numWorkers} worker threads (${threadsPerWorker} threads per worker)...`
        );

        const workerInferenceBatchSize = this.getWorkerInferenceBatchSize({ numWorkers });
        if (this.config.verbose && Number.isInteger(workerInferenceBatchSize)) {
          console.info(
            `[Indexer] Worker inference batch size: ${workerInferenceBatchSize}`
          );
        }

        for (let i = 0; i < numWorkers; i++) {
          try {
            const worker = new Worker(new URL('../lib/embedding-worker.js', import.meta.url), {
              workerData: {
                workerId: i,
                embeddingModel: this.config.embeddingModel,
                embeddingDimension: this.config.embeddingDimension || null,
                verbose: this.config.verbose,
                numThreads: threadsPerWorker,
                searchDirectory: this.config.searchDirectory,
                maxFileSize: this.config.maxFileSize,
                callGraphEnabled: this.config.callGraphEnabled,
                enableExplicitGc: this.config.enableExplicitGc,
                failFastEmbeddingErrors: this.config.failFastEmbeddingErrors === true,
                inferenceBatchSize: workerInferenceBatchSize,
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
                  reject(new Error(msg.error));
                }
              });

              worker.once('error', (err) => {
                clearTimeout(timeout);
                console.warn(`[Indexer] Worker initialization failed: ${err.message}`);
                reject(err);
              });
            });

            this.workers.push(worker);
            this.workerReady.push(readyPromise);
          } catch (err) {
            console.warn(`[Indexer] Failed to create worker ${i}: ${err.message}`);
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
          await this.terminateWorkers();
        }
      } finally {
        this.initWorkerPromise = null;
      }
    })();
    return this.initWorkerPromise;
  }

  /**
   * Terminate all worker threads
   */
  async terminateWorkers() {
    const WORKER_SHUTDOWN_TIMEOUT = isTestEnv() ? 50 : 5000;
    const terminations = this.workers.filter(Boolean).map((worker) => {
      try {
        worker.postMessage({ type: 'shutdown' });
      } catch {
        /* ignore */
      }

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

  /**
   * Send unload message to all workers to free their model memory.
   * This keeps workers alive but releases the embedding model from RAM.
   */
  async unloadWorkersModels() {
    if (this.workers.length === 0) return { unloaded: 0 };

    const UNLOAD_TIMEOUT = 10000;
    let unloadedCount = 0;

    const unloadPromises = this.workers.filter(Boolean).map((worker, idx) => {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (this.config.verbose) {
            console.warn(`[Indexer] Worker ${idx} unload timed out`);
          }
          resolve(false);
        }, UNLOAD_TIMEOUT);

        const handler = (msg) => {
          if (msg?.type === 'unload-complete') {
            clearTimeout(timeout);
            worker.off('message', handler);
            if (msg.wasLoaded) unloadedCount++;
            resolve(true);
          }
        };

        worker.on('message', handler);
        try {
          worker.postMessage({ type: 'unload' });
        } catch (err) {
          clearTimeout(timeout);
          worker.off('message', handler);
          if (this.config.verbose) {
            console.warn(`[Indexer] Failed to send unload to worker ${idx}: ${err.message}`);
          }
          resolve(false);
        }
      });
    });

    await Promise.all(unloadPromises);

    if (this.config.verbose) {
      console.info(`[Indexer] Unloaded models from ${unloadedCount} workers`);
    }

    return { unloaded: unloadedCount };
  }

  /**
   * Send unload message to the embedding child process.
   * This frees the embedding model from RAM in the child process.
   */
  async unloadEmbeddingChildModel() {
    const child = this._embeddingChild;
    if (!child) return { success: true, wasLoaded: false };

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.config.verbose) {
          console.warn('[Indexer] Embedding child unload timed out');
        }
        resolve({ success: false, timeout: true });
      }, 10000);

      const onData = (data) => {
        try {
          const lines = data.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            const parsed = JSON.parse(line);
            if (parsed?.success !== undefined) {
              clearTimeout(timeout);
              child.stdout.off('data', onData);
              resolve(parsed);
              return;
            }
          }
        } catch {
          // Not JSON or incomplete, keep waiting
        }
      };

      child.stdout.on('data', onData);

      try {
        child.stdin.write(`${JSON.stringify({ type: 'unload' })}\n`);
      } catch (err) {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        if (this.config.verbose) {
          console.warn(`[Indexer] Failed to send unload to child: ${err.message}`);
        }
        resolve({ success: false, error: err.message });
      }
    });
  }

  /**
   * Unload embedding models from all sources (workers and child process) to free RAM.
   * This is called after indexing when unloadModelAfterIndex is enabled.
   */
  async unloadEmbeddingModels() {
    const results = { workers: 0, childUnloaded: false };

    // Unload from workers (or terminate them - termination also frees memory)
    if (this.workers.length > 0) {
      // Terminating workers is more reliable than unloading in-place
      // since it fully releases the ONNX runtime memory
      if (this.config.verbose) {
        console.info(`[Indexer] Terminating ${this.workers.length} workers to free model memory`);
      }
      await this.terminateWorkers();
      results.workers = this.workers.length;
    }

    // Unload from persistent embedding child process
    if (this._embeddingChild) {
      const childResult = await this.unloadEmbeddingChildModel();
      results.childUnloaded = childResult?.wasLoaded || false;
      if (this.config.verbose) {
        console.info(`[Indexer] Embedding child model unloaded: ${results.childUnloaded}`);
      }
    }

    // Trigger GC in main process if configured
    if (this.isExplicitGcEnabled()) {
      const before = process.memoryUsage();
      this.runExplicitGc({ force: true });
      const after = process.memoryUsage();
      if (this.config.verbose) {
        console.info(
          `[Indexer] Post-unload GC: rss ${(before.rss / 1024 / 1024).toFixed(1)}MB -> ${(after.rss / 1024 / 1024).toFixed(1)}MB`
        );
      }
    }

    return results;
  }


  async loadGitignore() {
    if (!this.config.searchDirectory) {
      this.gitignore = ignore();
      return;
    }
    try {
      const gitignorePath = path.join(this.config.searchDirectory, '.gitignore');
      const content = await fs.readFile(gitignorePath, 'utf8');
      this.gitignore = ignore().add(content);
      if (this.config.verbose) console.info('[Indexer] Loaded .gitignore rules');
    } catch (_e) {
      // No .gitignore or error reading it
      this.gitignore = ignore();
    }
  }

  getCacheRelativePath() {
    if (!this.config.cacheDirectory || !this.config.searchDirectory) return null;
    const relative = path.relative(this.config.searchDirectory, this.config.cacheDirectory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return normalizePath(relative);
  }

  isExcluded(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      return false;
    }

    let relative = filePath;
    if (path.isAbsolute(filePath)) {
      if (this.config.searchDirectory) {
        relative = path.relative(this.config.searchDirectory, filePath);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
          return false;
        }
      } else {
        const root = path.parse(filePath).root;
        relative = filePath.slice(root.length);
      }
    }

    relative = normalizePath(relative);

    if (matchesExcludePatterns(relative, this.excludeMatchers)) return true;

    if (this.gitignore.ignores(relative)) return true;

    return false;
  }

  async replaceDeadWorker(index) {
    if (this.config.verbose) console.info(`[Indexer] Replacing dead worker at index ${index}...`);

    // Use 1 thread per worker to match initializeWorkers and prevent CPU saturation
    const threadsPerWorker = 1;
    const activeWorkerCount = this.workers.filter(Boolean).length || 1;
    const workerInferenceBatchSize = this.getWorkerInferenceBatchSize({
      numWorkers: activeWorkerCount,
    });
    const newWorker = new Worker(new URL('../lib/embedding-worker.js', import.meta.url), {
      workerData: {
        workerId: index,
        embeddingModel: this.config.embeddingModel,
        embeddingDimension: this.config.embeddingDimension || null,
        verbose: this.config.verbose,
        numThreads: threadsPerWorker,
        searchDirectory: this.config.searchDirectory,
        maxFileSize: this.config.maxFileSize,
        callGraphEnabled: this.config.callGraphEnabled,
        enableExplicitGc: this.config.enableExplicitGc,
        failFastEmbeddingErrors: this.config.failFastEmbeddingErrors === true,
        inferenceBatchSize: workerInferenceBatchSize,
      },
    });

    // Wait for ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), 30000);
      newWorker.once('message', (msg) => {
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          resolve();
        }
      });
      newWorker.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    this.workers[index] = newWorker;
    if (this.config.verbose) console.info(`[Indexer] Worker ${index} respawned successfully`);
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
    this.writeProgressFile(progress, total, message).catch(() => null);
  }

  async writeProgressFile(progress, total, message) {
    if (!this.config.enableCache) return;

    const payload = {
      progress,
      total,
      message,
      updatedAt: new Date().toISOString(),
      indexMode: this.currentIndexMode || null,
      workerCircuitOpen: !!this.workerCircuitOpen,
      workersDisabledUntil: Number.isFinite(this.workersDisabledUntil)
        ? this.workersDisabledUntil
        : null,
    };

    const prev = this._lastProgress;
    if (
      prev &&
      prev.progress === payload.progress &&
      prev.total === payload.total &&
      prev.message === payload.message
    ) {
      return;
    }

    this._lastProgress = payload;
    try {
      await fs.mkdir(this.config.cacheDirectory, { recursive: true });
      const progressPath = path.join(this.config.cacheDirectory, 'progress.json');
      await fs.writeFile(progressPath, JSON.stringify(payload), 'utf-8');
    } catch {
      // ignore progress write errors
    }
  }

  async processFilesWithWorkers(allFiles) {
    const allowedFiles = [];
    for (const entry of allFiles) {
      if (await this.isPathInsideWorkspaceReal(entry.file)) {
        allowedFiles.push(entry);
      }
    }
    if (allowedFiles.length !== allFiles.length) {
      console.warn(
        `[Indexer] Skipping ${allFiles.length - allowedFiles.length} file(s) outside workspace`
      );
    }
    if (allowedFiles.length === 0) {
      return [];
    }

    // Wait for any pending worker replacements to complete before distributing work
    if (this._workerReplacementPromises && this._workerReplacementPromises.size > 0) {
      await Promise.all(this._workerReplacementPromises.values());
    }

    const activeWorkers = this.workers
      .map((worker, index) => ({ worker, index }))
      .filter((entry) => entry.worker);

    if (activeWorkers.length === 0) {
      // Fallback: This method shouldn't be called if workers aren't available,
      // but if it is, we return empty and let the caller handle legacy fallback.
      return [];
    }

    const results = [];
    const chunkSize = Math.ceil(allowedFiles.length / activeWorkers.length);
    const workerPromises = [];
    const configuredTimeout = Number.isInteger(this.config.workerBatchTimeoutMs)
      ? this.config.workerBatchTimeoutMs
      : 300000;
    const WORKER_TIMEOUT = isTestEnv() ? 1000 : configuredTimeout;

    for (let i = 0; i < activeWorkers.length; i++) {
      const { worker, index: workerIndex } = activeWorkers[i];
      const workerFiles = allowedFiles.slice(i * chunkSize, (i + 1) * chunkSize);
      if (workerFiles.length === 0) continue;

      if (this.config.verbose) {
        console.info(`[Indexer] Worker ${workerIndex}: processing ${workerFiles.length} files`);
      }

      const promise = new Promise((resolve) => {
        const batchId = `file-batch-${i}-${Date.now()}`;
        const batchResults = [];
        let workerKilled = false; // Atomic guard against duplicate kills

        const killWorker = async () => {
          // Atomic guard: prevent concurrent killWorker calls for same worker
          if (workerKilled || this.workers[workerIndex] === null) return;
          workerKilled = true;
          this.workers[workerIndex] = null; // Mark as dead immediately before async work
          try {
            await worker.terminate?.();
          } catch (_err) {
            // ignore termination errors
          }
          // Track worker replacement to prevent concurrent replacements for the same slot
          if (!this._workerReplacementPromises) {
            this._workerReplacementPromises = new Map();
          }
          if (!this._workerReplacementPromises.has(workerIndex)) {
            // Use IIFE to ensure cleanup happens in finally block even on sync errors
            const replacement = (async () => {
              try {
                await this.replaceDeadWorker(workerIndex);
              } catch (err) {
                console.warn(`[Indexer] Failed to replace worker ${workerIndex}: ${err.message}`);
              } finally {
                this._workerReplacementPromises.delete(workerIndex);
              }
            })();
            this._workerReplacementPromises.set(workerIndex, replacement);
          }
        };

        const handleTimeout = () => {
          // Terminate first to ensure no more messages arrive
          void killWorker();
          worker.off('message', handler);
          worker.off('error', errorHandler);
          console.warn(`[Indexer] Worker ${workerIndex} timed out (files)`);
          this.recordWorkerFailure(`timeout (batch ${batchId})`);
          resolve([]);
        };

        let timeout = setTimeout(handleTimeout, WORKER_TIMEOUT);

        const finalize = (results) => {
          clearTimeout(timeout);
          worker.off('message', handler);
          worker.off('error', errorHandler);
          resolve(results);
        };

        const handler = (msg) => {
          if (msg.batchId === batchId) {
            if (msg.type === 'results') {
              if (Array.isArray(msg.results)) {
                batchResults.push(...msg.results);
              }
              if (msg.done) {
                finalize(batchResults);
              }
            } else if (msg.type === 'error') {
              finalize([]);
            }
          }
        };

        const errorHandler = (err) => {
          console.warn(`[Indexer] Worker ${workerIndex} crashed: ${err.message}`);
          this.recordWorkerFailure(`crash (${err.message})`);
          void killWorker();
          finalize([]);
        };

        worker.once('error', errorHandler);
        worker.on('message', handler);

        try {
          worker.postMessage({
            type: 'processFiles',
            files: workerFiles,
            batchId,
            chunkConfig: this.config,
          });
        } catch (_error) {
          finalize([]);
        }
      });

      workerPromises.push({ promise, files: workerFiles });
    }

    const workerResults = await Promise.all(workerPromises.map((p) => p.promise));

    // Identify failed files for retry
    const failedFiles = [];
    for (let i = 0; i < workerResults.length; i++) {
      if (workerResults[i].length > 0) {
        results.push(...workerResults[i]);
      } else if (workerPromises[i].files.length > 0) {
        failedFiles.push(...workerPromises[i].files);
      }
    }

    // Pass failed files back to be handled by legacy path
    if (failedFiles.length > 0) {
      if (this.config.verbose) {
        console.warn(
          `[Indexer] ${failedFiles.length} files failed in workers, falling back to main thread`
        );
      }
      // Mark these as failed in the results so the caller knows to process them manually
      for (const f of failedFiles) {
        results.push({ file: f.file, status: 'retry' });
      }
    }

    return results;
  }

  /**
   * Process chunks using worker thread pool with timeout and error recovery
   */
  async processChunksWithWorkers(allChunks) {
    const activeWorkers = this.workers
      .map((worker, index) => ({ worker, index }))
      .filter((entry) => entry.worker);

    if (activeWorkers.length === 0) {
      // Fallback to single-threaded processing
      return this.processChunksSingleThreaded(allChunks);
    }

    const results = [];
    const allowSingleThreadFallback = this.config.allowSingleThreadFallback !== false;
    const chunkSize = Math.ceil(allChunks.length / activeWorkers.length);
    const workerPromises = [];
    const configuredTimeout = Number.isInteger(this.config.workerBatchTimeoutMs)
      ? this.config.workerBatchTimeoutMs
      : 300000;
    const WORKER_TIMEOUT = isTestEnv() ? 1000 : configuredTimeout; // 1s in tests, configurable in prod

    if (this.config.verbose) {
      console.info(
        `[Indexer] Distributing ${allChunks.length} chunks across ${activeWorkers.length} workers (~${chunkSize} chunks each)`
      );
    }

    for (let i = 0; i < activeWorkers.length; i++) {
      const { worker, index: workerIndex } = activeWorkers[i];
      const workerChunks = allChunks.slice(i * chunkSize, (i + 1) * chunkSize);
      if (workerChunks.length === 0) continue;

      if (this.config.verbose) {
        console.info(`[Indexer] Worker ${workerIndex}: processing ${workerChunks.length} chunks`);
      }

      const promise = new Promise((resolve, _reject) => {
        const batchId = `batch-${i}-${Date.now()}`;
        const batchResults = [];
        let workerKilled = false; // Atomic guard against duplicate kills

        // Timeout handler
        const killWorker = async () => {
          // Atomic guard: prevent concurrent killWorker calls for same worker
          if (workerKilled || this.workers[workerIndex] === null) return;
          workerKilled = true;
          this.workers[workerIndex] = null; // Mark as dead immediately before async work
          try {
            await worker.terminate?.();
          } catch {
            // ignore terminate errors
          }

          // Track worker replacement to prevent concurrent replacements for the same slot
          if (!this._workerReplacementPromises) {
            this._workerReplacementPromises = new Map();
          }
          if (!this._workerReplacementPromises.has(workerIndex)) {
            const replacement = this.replaceDeadWorker(workerIndex)
              .catch((err) => {
                console.warn(`[Indexer] Failed to replace worker ${workerIndex}: ${err.message}`);
              })
              .finally(() => {
                this._workerReplacementPromises.delete(workerIndex);
              });
            this._workerReplacementPromises.set(workerIndex, replacement);
          }
        };

        const handleTimeout = (label) => {
          // Terminate first to ensure no more messages arrive
          void killWorker();
          worker.off('message', handler);
          worker.off('error', errorHandler);
          if (exitHandler) worker.off('exit', exitHandler);
          console.warn(`[Indexer] Worker ${workerIndex} timed out, ${label}`);
          this.recordWorkerFailure(`timeout (batch ${batchId})`);
          // Return empty and let fallback handle it
          resolve([]);
        };

        let timeout = setTimeout(
          () => handleTimeout('killing worker and falling back to single-threaded for this batch'),
          WORKER_TIMEOUT
        );

        const resetTimeout = () => {
          clearTimeout(timeout);
          timeout = setTimeout(
            () =>
              handleTimeout('killing worker and falling back to single-threaded for this batch'),
            WORKER_TIMEOUT
          );
        };

        let exitHandler;

        const finalize = (results) => {
          clearTimeout(timeout);
          worker.off('message', handler);
          worker.off('error', errorHandler);
          if (exitHandler) worker.off('exit', exitHandler);
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
              console.warn(`[Indexer] Worker ${workerIndex} error: ${msg.error}`);
              finalize([]); // Return empty, don't reject - let fallback handle
            }
          }
        };

        // Handle worker crash
        const errorHandler = (err) => {
          console.warn(`[Indexer] Worker ${workerIndex} crashed: ${err.message}`);
          this.recordWorkerFailure(`crash (${err.message})`);
          void killWorker();
          finalize([]); // Return empty, don't reject
        };
        worker.once('error', errorHandler);

        exitHandler = (code) => {
          if (code !== 0) {
            console.warn(`[Indexer] Worker ${workerIndex} exited unexpectedly with code ${code}`);
            this.recordWorkerFailure(`exit ${code}`);
            void killWorker();
            finalize([]);
          }
        };
        worker.once('exit', exitHandler);

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
    if (failedChunks.length > 0 && allowSingleThreadFallback) {
      console.warn(
        `[Indexer] Retrying ${failedChunks.length} chunks with single-threaded fallback...`
      );
      const retryResults = await this.processChunksSingleThreaded(failedChunks);
      results.push(...retryResults);
    } else if (failedChunks.length > 0) {
      console.warn(
        `[Indexer] Skipping ${failedChunks.length} chunks (single-threaded fallback disabled)`
      );
    }

    return results;
  }

  async startEmbeddingProcessSession() {
    if (this._embeddingChild) return;

    const nodePath = process.execPath || 'node';
    const scriptPath = fileURLToPath(new URL('../lib/embedding-process.js', import.meta.url));
    const child = spawn(nodePath, ['--expose-gc', scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        EMBEDDING_PROCESS_PERSISTENT: 'true',
      },
    });

    this._embeddingChild = child;
    this._embeddingProcessSessionActive = true;
    this._embeddingChildStopping = false;
    this._embeddingChildBuffer = '';
    this._embeddingChildQueue = [];
    if (!this._embeddingSessionStats) {
      this._embeddingSessionStats = {
        startedAt: Date.now(),
        requests: 0,
        chunks: 0,
        totalRequestMs: 0,
      };
    }

    const childPid = child?.pid ?? 'unknown';
    if (this.config.verbose) {
      console.info(`[Indexer] Persistent embedding process started pid=${childPid}`);
    }

    child.stdout.on('data', (chunk) => {
      this._handleEmbeddingChildStdout(chunk);
    });

    child.stderr.on('data', (chunk) => {
      if (this.config.verbose) {
        const msg = chunk.toString().trim();
        if (msg) {
          console.info(`[Indexer] Persistent embedding pid=${childPid}: ${msg}`);
        }
      }
    });

    child.on('error', (err) => {
      if (this.config.verbose) {
        console.warn(`[Indexer] Persistent embedding error pid=${childPid}: ${err.message}`);
      }
      this._failEmbeddingChildQueue(`child process error (${err.message})`);
      this._embeddingChild = null;
      this._embeddingProcessSessionActive = false;
    });

    child.on('close', (code, signal) => {
      if (this.config.verbose) {
        console.info(
          `[Indexer] Persistent embedding process exit pid=${childPid} code=${code ?? 'null'}${signal ? ` signal=${signal}` : ''}`
        );
      }
      this._failEmbeddingChildQueue(
        `child process exited (${code ?? 'null'}${signal ? `, signal=${signal}` : ''})`
      );
      this._embeddingChild = null;
      this._embeddingProcessSessionActive = false;
    });
  }

  _handleEmbeddingChildStdout(chunk) {
    this._embeddingChildBuffer += chunk.toString();
    let newlineIndex = this._embeddingChildBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this._embeddingChildBuffer.slice(0, newlineIndex).trim();
      this._embeddingChildBuffer = this._embeddingChildBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          if (this.config.verbose) {
            console.warn(`[Indexer] Persistent embedding response parse error: ${err.message}`);
          }
        }
        const entry = this._embeddingChildQueue.shift();
        if (entry) {
          clearTimeout(entry.timeoutId);
          entry.done = true;
          const elapsed = ((Date.now() - entry.startedAt) / 1000).toFixed(1);
          if (this.config.verbose) {
            console.info(
              `[Indexer] Child embedding request done id=${entry.requestId} pid=${entry.pid} chunks=${entry.chunks} elapsed=${elapsed}s`
            );
          }
          if (this._embeddingSessionStats) {
            this._embeddingSessionStats.totalRequestMs += Date.now() - entry.startedAt;
          }
          const rssMb = Number(parsed?.meta?.rssMb);
          if (Number.isFinite(rssMb) && rssMb >= this._embeddingChildRestartThresholdMb) {
            if (this.config.verbose) {
              console.warn(
                `[Indexer] Child embedding RSS ${rssMb.toFixed(1)}MB exceeds threshold ${this._embeddingChildRestartThresholdMb.toFixed(1)}MB; will restart child after request`
              );
            }
            this._embeddingChildNeedsRestart = true;
          }
          entry.resolve(parsed?.results || []);
        } else if (this.config.verbose) {
          const isControlResponse =
            parsed &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed) &&
            Object.prototype.hasOwnProperty.call(parsed, 'success') &&
            !Object.prototype.hasOwnProperty.call(parsed, 'results');
          if (isControlResponse || this._embeddingChildStopping) {
            newlineIndex = this._embeddingChildBuffer.indexOf('\n');
            continue;
          }
          console.warn('[Indexer] Persistent embedding response with no pending request');
        }
      }
      newlineIndex = this._embeddingChildBuffer.indexOf('\n');
    }
  }

  _failEmbeddingChildQueue(reason) {
    while (this._embeddingChildQueue.length > 0) {
      const entry = this._embeddingChildQueue.shift();
      clearTimeout(entry.timeoutId);
      if (entry.done) {
        continue;
      }
      if (this.config.verbose) {
        console.warn(`[Indexer] Persistent embedding request failed: ${reason}`);
      }
      entry.done = true;
      entry.resolve([]);
    }
  }

  async stopEmbeddingProcessSession({ preserveStats = false } = {}) {
    const child = this._embeddingChild;
    if (!child) {
      this._embeddingChildStopping = false;
      return;
    }
    this._embeddingChildStopping = true;
    const childPid = child?.pid ?? 'unknown';
    if (this.config.verbose) {
      console.info(`[Indexer] Stopping persistent embedding process pid=${childPid}`);
    }
    try {
      child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    if (this.config.verbose && this._embeddingSessionStats && !preserveStats) {
      const elapsedMs = Date.now() - this._embeddingSessionStats.startedAt;
      const elapsedSec = (elapsedMs / 1000).toFixed(1);
      const avgRequestMs = this._embeddingSessionStats.requests
        ? (
            this._embeddingSessionStats.totalRequestMs / this._embeddingSessionStats.requests
          ).toFixed(1)
        : '0.0';
      const avgChunksPerReq = this._embeddingSessionStats.requests
        ? (this._embeddingSessionStats.chunks / this._embeddingSessionStats.requests).toFixed(1)
        : '0.0';
      const avgMsPerChunk = this._embeddingSessionStats.chunks
        ? (this._embeddingSessionStats.totalRequestMs / this._embeddingSessionStats.chunks).toFixed(
            1
          )
        : '0.0';
      console.info(
        `[Indexer] Persistent embedding summary: requests=${this._embeddingSessionStats.requests} chunks=${this._embeddingSessionStats.chunks} avgChunksPerReq=${avgChunksPerReq} avgReqMs=${avgRequestMs} avgMsPerChunk=${avgMsPerChunk} totalElapsed=${elapsedSec}s`
      );
    }
    this._embeddingChild = null;
    this._embeddingProcessSessionActive = false;
    this._embeddingChildStopping = false;
    // Clear buffers to release memory
    this._embeddingChildBuffer = '';
    this._embeddingChildQueue = [];
    if (!preserveStats) {
      this._embeddingSessionStats = null;
    }
  }

  async processChunksInPersistentChild(chunks) {
    if (!this._embeddingChild) {
      await this.startEmbeddingProcessSession();
    }
    if (!this._embeddingChild) {
      return [];
    }

    const child = this._embeddingChild;
    const childPid = child?.pid ?? 'unknown';
    const requestId = this._embeddingRequestId++;
    const { threads, batchSize } = this.getEmbeddingProcessConfig();
    const payload = {
      embeddingModel: this.config.embeddingModel,
      chunks,
      numThreads: threads,
      batchSize,
      enableExplicitGc: this.config.enableExplicitGc,
      requestId,
    };
    const timeoutMs = Number.isInteger(this.config.workerBatchTimeoutMs)
      ? this.config.workerBatchTimeoutMs
      : 120000;

    return new Promise((resolve) => {
      const startedAt = Date.now();
      const entry = {
        resolve,
        timeoutId: null,
        startedAt,
        chunks: Array.isArray(chunks) ? chunks.length : 0,
        pid: childPid,
        requestId,
        done: false,
      };

      if (this.config.verbose) {
        console.info(
          `[Indexer] Child embedding request started id=${requestId} pid=${childPid} chunks=${entry.chunks} queue=${this._embeddingChildQueue.length}`
        );
      }
      if (this._embeddingSessionStats) {
        this._embeddingSessionStats.requests += 1;
        this._embeddingSessionStats.chunks += entry.chunks;
      }

      entry.timeoutId = setTimeout(() => {
        if (entry.done) {
          return;
        }
        entry.done = true;
        this._embeddingChildQueue = this._embeddingChildQueue.filter((item) => item !== entry);
        if (this.config.verbose) {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          console.warn(
            `[Indexer] Child embedding request timeout id=${requestId} pid=${childPid} elapsed=${elapsed}s limit=${(timeoutMs / 1000).toFixed(1)}s`
          );
        }
        this.recordWorkerFailure('child process timeout');
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve([]);
      }, timeoutMs);

      this._embeddingChildQueue.push(entry);
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        clearTimeout(entry.timeoutId);
        this.recordWorkerFailure(`child process error (${err.message})`);
        resolve([]);
      }
    }).then(async (results) => {
      if (this._embeddingChildNeedsRestart && this._embeddingChildQueue.length === 0) {
        this._embeddingChildNeedsRestart = false;
        await this.stopEmbeddingProcessSession({ preserveStats: true });
        await this.startEmbeddingProcessSession();
      }
      return this.applyEmbeddingDimensionToResults(results);
    });
  }

  applyEmbeddingDimensionToResults(results) {
    const targetDim = this.config.embeddingDimension;
    if (!targetDim || !Array.isArray(results)) {
      return results;
    }
    for (const result of results) {
      if (!result || !result.vector) continue;
      const floatVector = toFloat32Array(result.vector);
      result.vector = sliceAndNormalize(floatVector, targetDim);
    }
    return results;
  }

  async processChunksInChildProcess(chunks) {
    if (this._embeddingProcessSessionActive) {
      return this.processChunksInPersistentChild(chunks);
    }
    const nodePath = process.execPath || 'node';
    const scriptPath = fileURLToPath(new URL('../lib/embedding-process.js', import.meta.url));
    const { threads, batchSize } = this.getEmbeddingProcessConfig();
    const payload = {
      embeddingModel: this.config.embeddingModel,
      chunks,
      numThreads: threads,
      batchSize,
      enableExplicitGc: this.config.enableExplicitGc,
    };

    return new Promise((resolve) => {
      const startedAt = Date.now();
      const child = spawn(nodePath, ['--expose-gc', scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const childPid = child?.pid ?? 'unknown';
      if (this.config.verbose) {
        console.info(
          `[Indexer] Child embedding process started pid=${childPid} chunks=${Array.isArray(chunks) ? chunks.length : 0}`
        );
      }

      let stdout = '';
      let stderr = '';
      let closed = false;
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      const timeoutMs = Number.isInteger(this.config.workerBatchTimeoutMs)
        ? this.config.workerBatchTimeoutMs
        : 120000;
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        if (this.config.verbose && !closed) {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          console.warn(
            `[Indexer] Child embedding process timeout pid=${childPid} elapsed=${elapsed}s limit=${(timeoutMs / 1000).toFixed(1)}s`
          );
        }
        this.recordWorkerFailure('child process timeout');
        resolve([]);
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timeout);
        if (this.config.verbose && !closed) {
          console.warn(`[Indexer] Child embedding process error pid=${childPid}: ${err.message}`);
        }
        this.recordWorkerFailure(`child process error (${err.message})`);
        resolve([]);
      });

      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        closed = true;
        if (this.config.verbose) {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          console.info(
            `[Indexer] Child embedding process exit pid=${childPid} code=${code ?? 'null'}${signal ? ` signal=${signal}` : ''} elapsed=${elapsed}s`
          );
          const { rss, heapUsed, heapTotal } = process.memoryUsage();
          const toMb = (value) => `${(value / 1024 / 1024).toFixed(1)}MB`;
          console.info(
            `[Indexer] Memory after child exit: rss=${toMb(rss)} heap=${toMb(heapUsed)}/${toMb(heapTotal)}`
          );
        }
        if (code !== 0) {
          this.recordWorkerFailure(
            `child process exited (${code ?? 'null'}${signal ? `, signal=${signal}` : ''})`
          );
          if (stderr) {
            console.warn(`[Indexer] Child process error: ${stderr.trim()}`);
          }
          return resolve([]);
        }
        try {
          const parsed = JSON.parse(stdout);
          // Clear large JSON buffer immediately after parsing to release memory
          stdout = '';
          stderr = '';
          resolve(this.applyEmbeddingDimensionToResults(parsed?.results || []));
        } catch (err) {
          // Clear buffers on error too
          stdout = '';
          stderr = '';
          this.recordWorkerFailure(`child process parse error (${err.message})`);
          resolve([]);
        }
      });

      child.stdin.end(JSON.stringify(payload));
    });
  }

  /**
   * Single-threaded chunk processing (fallback)
   */
  async processChunksSingleThreaded(chunks) {
    const results = [];

    // Manual GC and yield loop to prevent CPU lockup
    let processedSinceGc = 0;

    for (const chunk of chunks) {
      // Throttle speed (balanced) - yield to event loop but don't wait unnecessarily
      await delay(0);

      try {
        const output = await this.embedder(chunk.text, {
          pooling: 'mean',
          normalize: true,
        });
        // CRITICAL: Deep copy to release ONNX tensor memory
        let vector = toFloat32Array(output.data);
        if (this.config.embeddingDimension) {
          vector = sliceAndNormalize(vector, this.config.embeddingDimension);
        }
        // Properly dispose tensor to release ONNX runtime memory
        if (typeof output.dispose === 'function') {
          try {
            output.dispose();
          } catch {
            /* frozen tensor */
          }
        }
        results.push({
          file: chunk.file,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.text,
          vector,
          success: true,
        });

        // Periodic GC to prevent memory creep
        processedSinceGc++;
        if (processedSinceGc >= 100) {
          this.runExplicitGc({ minIntervalMs: 5000 });
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
    if (typeof this.cache.ensureLoaded === 'function') {
      await this.cache.ensureLoaded();
    }
    if (!(await this.isPathInsideWorkspaceReal(file))) {
      console.warn(`[Indexer] Skipped ${path.basename(file)} (outside workspace)`);
      return 0;
    }
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
        }
        return 0;
      }

      const content = await fs.readFile(file, 'utf-8');
      const hash = hashContent(content);

      // Skip if file hasn't changed
      const cachedHash =
        typeof this.cache.getFileHash === 'function' ? this.cache.getFileHash(file) : null;
      if (cachedHash === hash) {
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

      // Extract call graph data if enabled
      let callData = null;
      if (this.config.callGraphEnabled) {
        try {
          callData = extractCallData(content, file);
        } catch (err) {
          if (this.config.verbose) {
            console.warn(`[Indexer] Call graph extraction failed for ${fileName}: ${err.message}`);
          }
        }
      }

      const rawChunks = smartChunk(content, file, this.config);
      const chunks = Array.isArray(rawChunks) ? rawChunks : [];
      let addedChunks = 0;
      let successChunks = 0;
      let failedChunks = 0;
      const newChunks = [];

      // Use workers for watcher-triggered embedding to keep main thread responsive
      let useWorkers = this.shouldUseWorkers();
      if (useWorkers && this.workers.length === 0) {
        await this.initializeWorkers();
        if (this.workers.length === 0) {
          useWorkers = false;
        }
      }
      const useEmbeddingProcessPerBatch = this.shouldUseEmbeddingProcessPerBatch(useWorkers);
      let embeddingRuntimeSummary = '';
      if (useWorkers && this.workers.length > 0) {
        const workerInferenceBatchSize =
          this.getWorkerInferenceBatchSize({ numWorkers: this.workers.length }) ?? 'default';
        embeddingRuntimeSummary =
          `mode=worker-pool workers=${this.workers.length} onnxThreadsPerWorker=1 ` +
          `effectiveThreads=${this.workers.length} inferenceBatchSize=${workerInferenceBatchSize}`;
      } else if (useEmbeddingProcessPerBatch) {
        const { threads, batchSize } = this.getEmbeddingProcessConfig();
        embeddingRuntimeSummary =
          `mode=child-process onnxThreads=${threads} ` +
          `inferenceBatchSize=${batchSize ?? 1} persistentSession=${this._embeddingProcessSessionActive ? 'true' : 'false'}`;
      } else {
        embeddingRuntimeSummary = 'mode=main-thread onnxThreads=auto';
      }
      console.info(`[Indexer] Embedding runtime: ${embeddingRuntimeSummary}`);

      const chunksToProcess = chunks.map((c) => ({
        file,
        text: c.text,
        startLine: c.startLine,
        endLine: c.endLine,
      }));

      let results = [];
      if (useWorkers && this.workers.length > 0) {
        results = await this.processChunksWithWorkers(chunksToProcess);
      } else if (useEmbeddingProcessPerBatch) {
        results = await this.processChunksInChildProcess(chunksToProcess);
      } else {
        results = await this.processChunksSingleThreaded(chunksToProcess);
      }

      for (const result of results) {
        if (result.success) {
          newChunks.push({
            file,
            startLine: result.startLine,
            endLine: result.endLine,
            content: result.content,
            vector: toFloat32Array(result.vector),
          });
          addedChunks++;
          successChunks++;
        } else {
          console.warn(`[Indexer] Failed to embed chunk in ${fileName}:`, result.error);
          failedChunks++;
        }
      }

      const totalChunks = chunks.length;
      const allSucceeded = totalChunks === 0 || failedChunks === 0;

      if (allSucceeded) {
        this.cache.removeFileFromStore(file);
        for (const chunk of newChunks) {
          this.cache.addToStore(chunk);
        }
        this.cache.setFileHash(file, hash, stats);
        if (this.config.callGraphEnabled && callData) {
          this.cache.setFileCallData(file, callData);
        }
      } else if (this.config.verbose) {
        console.warn(
          `[Indexer] Skipped hash update for ${fileName} (${successChunks}/${totalChunks} chunks embedded)`
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
    const extensions = new Set(
      this.config.fileExtensions.map((ext) => `.${String(ext).toLowerCase()}`)
    );
    const allowedFileNames = new Set(this.config.fileNames || []);

    // Load .gitignore before discovery
    await this.loadGitignore();

    if (!this.config.searchDirectory) {
      return [];
    }

    const api = new fdir()
      .withFullPaths()
      .exclude((dirName, dirPath) => {
        // Always exclude specific heavy folders immediately
        if (dirName === 'node_modules' || dirName === '.git' || dirName === '.smart-coding-cache')
          return true;

        // Check exclusion rules for directories
        const fullPath = path.join(dirPath, dirName);
        return this.isExcluded(fullPath);
      })
      .filter((filePath) => {
        if (this.isExcluded(filePath)) return false;

        // Check extensions/filenames
        const base = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();
        return extensions.has(ext) || allowedFileNames.has(base);
      })
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

      const mtimeSafeWindowMs = isTestEnv()
        ? 0
        : Number.isInteger(this.config.mtimeSafeWindowMs)
          ? this.config.mtimeSafeWindowMs
          : 2000;
      const processReadBatch = async (batch) => {
        const results = await Promise.all(
          batch.map(async ({ file, size, mtimeMs }) => {
            // Check if we have cached metadata for this file
            const cachedHash =
              typeof this.cache.getFileHash === 'function' ? this.cache.getFileHash(file) : null;
            const cachedMeta = this.cache.getFileMeta ? this.cache.getFileMeta(file) : null;

            const metaMatches =
              cachedHash &&
              cachedMeta &&
              Number.isFinite(cachedMeta.mtimeMs) &&
              cachedMeta.mtimeMs === mtimeMs &&
              Number.isFinite(cachedMeta.size) &&
              cachedMeta.size === size;
            if (metaMatches) {
              // Avoid missing rapid edits on coarse timestamp filesystems.
              const now = Date.now();
              const isRecent = Math.abs(now - mtimeMs) <= mtimeSafeWindowMs;
              if (!isRecent) {
                // Metadata matches exactly, skip reading/hashing
                skippedCount.unchanged++;
                return null;
              }
            }

            // Suspect file: Either new, or metadata changed.
            // We pass it to indexAll with the cachedHash as 'expectedHash'
            // so workers can perform the actual hashing and unchanged check.
            return { file, hash: null, expectedHash: cachedHash, force: false, size, mtimeMs };
          })
        );

        for (const result of results) {
          if (result) filesToProcess.push(result);
        }
      };

      for (const item of fileStats) {
        if (!item) continue;

        if (currentReadBytes + item.size > MAX_READ_BATCH_BYTES && currentReadBatch.length > 0) {
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
        `[Indexer] Memory ${label}: rss=${toMb(rss)} heap=${toMb(heapUsed)}/${toMb(heapTotal)}`
      );
    };

    try {
      logMemory('start');
      if (this.config.verbose) {
        memoryTimer = setInterval(() => logMemory('periodic'), 15000);
      }

      if (force) {
        console.info('[Indexer] Force reindex requested: clearing cache');
        await this.cache.reset();
      } else {
        if (typeof this.cache.ensureLoaded === 'function') {
          await this.cache.ensureLoaded();
        }
      }

      const totalStartTime = Date.now();
      const indexStartedAt = new Date(totalStartTime).toISOString();
      let indexMode = force
        ? 'full'
        : this.cache.getVectorStore().length === 0
          ? 'initial'
          : 'incremental';
      this.currentIndexMode = indexMode;
      this.sendProgress(0, 100, 'Indexing started');
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
        const cachedFiles =
          typeof this.cache.getFileHashKeys === 'function' ? this.cache.getFileHashKeys() : [];
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
          }
          // If we pruned files, we should save these changes even if no other files changed
        }

        const prunedCallGraph = this.cache.pruneCallGraphData(currentFilesSet);
        if (prunedCallGraph > 0 && this.config.verbose) {
          console.info(`[Indexer] Pruned ${prunedCallGraph} call-graph entries`);
        }
      }

      // Step 2: Pre-filter unchanged files (early hash check)
      const filesToProcess = await this.preFilterFiles(files);
      const filesToProcessSet = new Set(filesToProcess.map((entry) => entry.file));
      const filesToProcessByFile = new Map(filesToProcess.map((entry) => [entry.file, entry]));

      // Re-index files missing call graph data (if enabled)
      if (this.config.callGraphEnabled && this.cache.getVectorStore().length > 0) {
        const cachedFiles = new Set(this.cache.getVectorStore().map((c) => c.file));
        const callDataFiles = new Set(this.cache.getFileCallDataKeys());

        const missingCallData = [];
        for (const file of cachedFiles) {
          if (!callDataFiles.has(file) && currentFilesSet.has(file)) {
            missingCallData.push(file);
            const existing = filesToProcessByFile.get(file);
            if (existing) existing.force = true;
          }
        }

        if (missingCallData.length > 0) {
          console.info(
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
                  return { file, hash, force: true, size: stats.size, mtimeMs: stats.mtimeMs };
                } catch {
                  return null;
                }
              })
            );

            for (const result of results) {
              if (!result) continue;
              if (!filesToProcessSet.has(result.file)) {
                filesToProcess.push(result);
                filesToProcessSet.add(result.file);
              }
            }
          }
        }
      }

      indexMode = force
        ? 'full'
        : this.cache.getVectorStore().length === 0
          ? 'initial'
          : filesToProcess.length === files.length
            ? 'full'
            : 'incremental';
      this.currentIndexMode = indexMode;

      if (filesToProcess.length === 0) {
        console.info('[Indexer] All files unchanged, nothing to index');
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

      // Send progress: filtering complete
      console.info(`[Indexer] Processing ${filesToProcess.length} changed files`);
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
      const allowSingleThreadFallback =
        this.config.allowSingleThreadFallback !== false ||
        this.config.workerThreads === 0 ||
        isTestEnv();
      let useWorkers = this.shouldUseWorkers();

      if (useWorkers) {
        await this.initializeWorkers();
        if (this.workers.length === 0) {
          useWorkers = false;
        } else if (this.config.verbose) {
          console.info(`[Indexer] Multi-threaded mode: ${this.workers.length} workers active`);
        }
      }

      const useEmbeddingProcessPerBatch = this.shouldUseEmbeddingProcessPerBatch(useWorkers);
      let embeddingRuntimeSummary = '';
      if (useWorkers && this.workers.length > 0) {
        // Worker pool is intentionally fixed to 1 ONNX thread per worker.
        const workerInferenceBatchSize =
          this.getWorkerInferenceBatchSize({ numWorkers: this.workers.length }) ?? 'default';
        embeddingRuntimeSummary =
          `mode=worker-pool workers=${this.workers.length} onnxThreadsPerWorker=1 ` +
          `effectiveThreads=${this.workers.length} inferenceBatchSize=${workerInferenceBatchSize}`;
      } else if (useEmbeddingProcessPerBatch) {
        const { threads, batchSize } = this.getEmbeddingProcessConfig();
        embeddingRuntimeSummary =
          `mode=child-process onnxThreads=${threads} ` +
          `inferenceBatchSize=${batchSize ?? 1} persistentSession=true`;
      } else {
        embeddingRuntimeSummary = 'mode=main-thread onnxThreads=auto';
      }
      console.info(`[Indexer] Embedding runtime: ${embeddingRuntimeSummary}`);

      if (!useWorkers && this.config.verbose) {
        const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : 0;
        const baseDetail = `cpu=${cpuCount}, embeddingProcessPerBatch=${useEmbeddingProcessPerBatch}, workerThreads=${this.config.workerThreads}`;
        const until = this.workersDisabledUntil - Date.now();
        if (this.workersDisabledUntil && until > 0) {
          console.info(
            `[Indexer] Workers disabled for ${Math.round(until / 1000)}s; using non-worker path (${baseDetail}); single-threaded fallback ${allowSingleThreadFallback ? 'enabled' : 'disabled'}`
          );
        } else {
          console.info(`[Indexer] Workers disabled; using non-worker path (${baseDetail})`);
        }
      }

      if (useEmbeddingProcessPerBatch) {
        try {
          await this.startEmbeddingProcessSession();
        } catch (err) {
          this._embeddingProcessSessionActive = false;
          if (this.config.verbose) {
            console.warn(`[Indexer] Failed to start persistent embedding process: ${err.message}`);
          }
        }
      }

      const resolvedWorkerThreads = useWorkers ? this.workers.length : 0;

      let totalChunks = 0;
      let processedFiles = 0;

      console.info(
        `[Indexer] Embedding pass started: ${filesToProcess.length} files using ${this.config.embeddingModel}`
      );

      // Step 5: Process files in adaptive batches
      for (let i = 0; i < filesToProcess.length; i += adaptiveBatchSize) {
        const batch = filesToProcess.slice(i, i + adaptiveBatchSize);

        const allChunks = [];
        const fileStats = new Map();
        const newChunksByFile = new Map();
        const callDataByFile = new Map();
        const filesForWorkers = [];

        // Memory safeguard
        const mem = process.memoryUsage();
        if (mem.rss > 2048 * 1024 * 1024) {
          this.runExplicitGc({ minIntervalMs: 5000 });
        }

        const useWorkersForBatch =
          useWorkers && this.workers.length > 0 && !useEmbeddingProcessPerBatch;

        for (const item of batch) {
          const {
            file,
            force,
            content: presetContent,
            hash: presetHash,
            expectedHash: presetExpectedHash,
            size: presetSize,
            mtimeMs: presetMtimeMs,
          } = item;
          let content = presetContent;
          let liveHash = presetHash;
          let size = presetSize;
          let mtimeMs = presetMtimeMs;
          const expectedHash =
            presetExpectedHash ||
            (typeof this.cache.getFileHash === 'function' ? this.cache.getFileHash(file) : null);

          if (useWorkersForBatch && (content === undefined || content === null)) {
            // Speed optimization: Offload reading and hashing to workers.
            // Main thread skips I/O entirely for this file.
            filesForWorkers.push({ file, content: null, force, expectedHash });
            // Initialize stats placeholder (will be updated with worker results)
            fileStats.set(file, { hash: null, totalChunks: 0, successChunks: 0, size, mtimeMs });
            continue;
          }

          // Read content if not provided (Legacy Path or workers disabled)
          if (content === undefined || content === null) {
            let stats = null;
            try {
              stats = await fs.stat(file);
            } catch (err) {
              if (this.config.verbose) {
                console.warn(`[Indexer] Failed to stat ${path.basename(file)}: ${err.message}`);
              }
              continue;
            }
            if (!stats || typeof stats.isDirectory !== 'function') {
              if (this.config.verbose) {
                console.warn(`[Indexer] Invalid stat result for ${path.basename(file)}`);
              }
              continue;
            }
            if (stats.isDirectory()) continue;
            if (stats.size > this.config.maxFileSize) {
              if (this.config.verbose) {
                console.warn(
                  `[Indexer] Skipped ${path.basename(file)} (too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB)`
                );
              }
              continue;
            }
            try {
              content = await fs.readFile(file, 'utf-8');
            } catch (err) {
              if (this.config.verbose) {
                console.warn(`[Indexer] Failed to read ${path.basename(file)}: ${err.message}`);
              }
              continue;
            }
            liveHash = hashContent(content);
            size = stats.size;
            mtimeMs = stats.mtimeMs;
          } else {
            if (typeof content !== 'string') content = String(content);
            if (!liveHash) liveHash = hashContent(content);
            if (!Number.isFinite(size)) {
              // Use character length as approximation to avoid blocking Buffer.byteLength on large strings
              size = content.length;
            }
            if (size > this.config.maxFileSize) {
              if (this.config.verbose) {
                console.warn(
                  `[Indexer] Skipped ${path.basename(file)} (too large: ${(size / 1024 / 1024).toFixed(2)}MB)`
                );
              }
              continue;
            }
          }

          const cachedFileHash =
            typeof this.cache.getFileHash === 'function' ? this.cache.getFileHash(file) : null;
          if (!force && liveHash && cachedFileHash === liveHash) {
            if (this.config.verbose)
              console.info(`[Indexer] Skipped ${path.basename(file)} (unchanged)`);
            this.cache.setFileHash(file, liveHash, { size, mtimeMs });
            continue;
          }

          if (useWorkersForBatch) {
            filesForWorkers.push({ file, content, force, expectedHash });
            // Initialize stats placeholder (will be updated with worker results)
            fileStats.set(file, {
              hash: liveHash,
              totalChunks: 0,
              successChunks: 0,
              size,
              mtimeMs,
            });
            continue;
          }

          // Legacy / Fallback path: Chunk on main thread
          if (this.config.callGraphEnabled) {
            try {
              const callData = extractCallData(content, file);
              callDataByFile.set(file, callData);
            } catch (err) {
              if (this.config.verbose) {
                console.warn(
                  `[Indexer] Call graph extraction failed for ${path.basename(file)}: ${err.message}`
                );
              }
            }
          }

          const rawChunks = smartChunk(content, file, this.config);
          const chunks = Array.isArray(rawChunks) ? rawChunks : [];
          fileStats.set(file, {
            hash: liveHash,
            totalChunks: chunks.length,
            successChunks: 0,
            size,
            mtimeMs,
          });

          for (const chunk of chunks) {
            allChunks.push({
              file,
              text: chunk.text,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
            });
          }
        }

        // Process files with workers (New Path)
        if (filesForWorkers.length > 0) {
          const results = await this.processFilesWithWorkers(filesForWorkers);

          for (const res of results) {
            const stats = fileStats.get(res.file);
            if (res.status === 'indexed' && stats) {
              stats.totalChunks = res.results.length;
              stats.successChunks = res.results.length;
              if (res.hash) stats.hash = res.hash; // Update with new hash from worker
              if (res.callData) callDataByFile.set(res.file, res.callData);

              const chunks = res.results.map((r) => ({
                file: res.file,
                startLine: r.startLine,
                endLine: r.endLine,
                content: r.text,
                vector: toFloat32Array(r.vectorBuffer),
              }));
              newChunksByFile.set(res.file, chunks);
            } else if (res.status === 'unchanged' && stats) {
              // Worker found file hash matches old hash
              stats.totalChunks = 0; // Signal skip commit
              stats.successChunks = 0;
              stats.hash = res.hash;
              this.cache.setFileHash(res.file, res.hash, { size: res.size, mtimeMs: res.mtimeMs });
              if (res.callData && this.config.callGraphEnabled) {
                this.cache.setFileCallData(res.file, res.callData);
              }
            } else if ((res.status === 'retry' || res.status === 'error') && stats) {
              // Worker failed, fallback to local chunking + single threaded
              const original = filesForWorkers.find((f) => f.file === res.file);
              if (original) {
                if (this.config.verbose)
                  console.info(`[Indexer] Fallback for ${path.basename(res.file)}`);

                let fallbackContent = original.content;
                let fallbackSize = stats.size;
                let fallbackMtimeMs = stats.mtimeMs;

                if (fallbackContent === undefined || fallbackContent === null) {
                  try {
                    const liveStats = await fs.stat(res.file);
                    if (!liveStats || typeof liveStats.isDirectory !== 'function') {
                      continue;
                    }
                    if (liveStats.isDirectory()) continue;
                    if (liveStats.size > this.config.maxFileSize) {
                      if (this.config.verbose) {
                        console.warn(
                          `[Indexer] Skipped ${path.basename(res.file)} (too large: ${(liveStats.size / 1024 / 1024).toFixed(2)}MB)`
                        );
                      }
                      continue;
                    }
                    fallbackContent = await fs.readFile(res.file, 'utf-8');
                    fallbackSize = liveStats.size;
                    fallbackMtimeMs = liveStats.mtimeMs;
                  } catch (err) {
                    if (this.config.verbose) {
                      console.warn(
                        `[Indexer] Fallback read failed for ${path.basename(res.file)}: ${err.message}`
                      );
                    }
                    continue;
                  }
                }
                if (typeof fallbackContent !== 'string') {
                  fallbackContent = String(fallbackContent);
                }
                stats.hash = hashContent(fallbackContent);
                if (Number.isFinite(fallbackSize)) stats.size = fallbackSize;
                if (Number.isFinite(fallbackMtimeMs)) stats.mtimeMs = fallbackMtimeMs;

                if (this.config.callGraphEnabled) {
                  try {
                    callDataByFile.set(res.file, extractCallData(fallbackContent, res.file));
                  } catch (err) {
                    if (this.config.verbose) {
                      console.warn(
                        `[Indexer] Call graph extraction failed for ${path.basename(res.file)}: ${err.message}`
                      );
                    }
                  }
                }
                const fallbackChunks = smartChunk(fallbackContent, res.file, this.config);
                const chunks = Array.isArray(fallbackChunks) ? fallbackChunks : [];
                stats.totalChunks = chunks.length;
                for (const chunk of chunks) {
                  allChunks.push({
                    file: res.file,
                    text: chunk.text,
                    startLine: chunk.startLine,
                    endLine: chunk.endLine,
                  });
                }
              }
            }
          }
        }

        // Process chunks (Legacy Path & Fallbacks)
        if (allChunks.length > 0) {
          const chunksToProcess = allChunks.slice();
          let results = [];
          if (useEmbeddingProcessPerBatch) {
            results = await this.processChunksInChildProcess(chunksToProcess);
          } else {
            // If we are here, either workers are disabled/full or these are retry chunks
            // Use single threaded fallback if not using child process
            results = await this.processChunksSingleThreaded(chunksToProcess);
          }

          for (const result of results) {
            const stats = fileStats.get(result.file);
            if (result.success && stats) {
              const items = newChunksByFile.get(result.file) || [];
              items.push({
                file: result.file,
                startLine: result.startLine,
                endLine: result.endLine,
                content: result.content,
                vector: toFloat32Array(result.vector),
              });
              newChunksByFile.set(result.file, items);
              stats.successChunks++;
            }
          }
        }

        // Commit changes to cache
        for (const [file, stats] of fileStats) {
          if (stats.totalChunks > 0 && stats.successChunks === stats.totalChunks) {
            this.cache.removeFileFromStore(file);
            const newChunks = newChunksByFile.get(file) || [];
            for (const chunk of newChunks) {
              this.cache.addToStore(chunk);
              totalChunks++;
            }
            if (typeof stats.hash === 'string' && stats.hash.length > 0) {
              this.cache.setFileHash(file, stats.hash, { size: stats.size, mtimeMs: stats.mtimeMs });
            } else if (this.config.verbose) {
              console.warn(`[Indexer] Skipped hash update for ${path.basename(file)} (missing hash)`);
            }
            const callData = callDataByFile.get(file);
            if (callData && this.config.callGraphEnabled) {
              this.cache.setFileCallData(file, callData);
            }
          } else if (stats.totalChunks === 0) {
            // File had no chunks (empty or comments only), just mark as indexed
            if (typeof stats.hash === 'string' && stats.hash.length > 0) {
              this.cache.setFileHash(file, stats.hash, { size: stats.size, mtimeMs: stats.mtimeMs });
            } else if (this.config.verbose) {
              console.warn(`[Indexer] Skipped hash update for ${path.basename(file)} (missing hash)`);
            }
            const callData = callDataByFile.get(file);
            if (callData && this.config.callGraphEnabled) {
              this.cache.setFileCallData(file, callData);
            }
          } else if (this.config.verbose) {
            console.warn(
              `[Indexer] Skipped hash update for ${path.basename(file)} (${stats.successChunks}/${stats.totalChunks} chunks embedded)`
            );
          }
        }

        this.runExplicitGc({ minIntervalMs: 5000 });

        processedFiles += batch.length;

        // Progress indicator
        if (
          processedFiles % (adaptiveBatchSize * 2) === 0 ||
          processedFiles === filesToProcess.length
        ) {
          const elapsedSeconds = (Date.now() - totalStartTime) / 1000;
          const elapsed = elapsedSeconds.toFixed(1);
          const rate = (processedFiles / Math.max(elapsedSeconds, 0.001)).toFixed(1);
          console.info(
            `[Indexer] Progress: ${processedFiles}/${filesToProcess.length} files (${rate} files/sec, ${elapsed}s elapsed)`
          );
          const progressPercent = Math.floor(10 + (processedFiles / filesToProcess.length) * 85);
          this.sendProgress(
            progressPercent,
            100,
            `Indexed ${processedFiles}/${filesToProcess.length} files (${rate}/sec)`
          );
        }

        // Batch-level memory cleanup to reduce peak usage
        allChunks.length = 0;
        filesForWorkers.length = 0;
        fileStats.clear();
        newChunksByFile.clear();
        callDataByFile.clear();
        await delay(0);
      }

      // Cleanup workers
      if (this.workers.length > 0) {
        await this.terminateWorkers();
      }
      this.runExplicitGc({ force: true });

      const totalDurationMs = Date.now() - totalStartTime;
      const totalTime = (totalDurationMs / 1000).toFixed(1);
      console.info(
        `[Indexer] Embedding pass complete: ${totalChunks} chunks from ${filesToProcess.length} files in ${totalTime}s`
      );

      // Send completion progress
      this.sendProgress(
        100,
        100,
        `Complete: ${totalChunks} chunks from ${filesToProcess.length} files in ${totalTime}s`
      );

      this.cache.setLastIndexDuration?.(totalDurationMs);
      this.cache.setLastIndexStats?.({
        lastIndexStartedAt: indexStartedAt,
        lastIndexEndedAt: new Date().toISOString(),
        lastDiscoveredFiles: files.length,
        lastFilesProcessed: filesToProcess.length,
        lastIndexMode: indexMode,
        lastBatchSize: adaptiveBatchSize,
        lastWorkerThreads: resolvedWorkerThreads,
        lastEmbeddingProcessPerBatch: useEmbeddingProcessPerBatch,
      });
      await this.cache.save();

      const vectorStoreSnapshot = this.cache.getVectorStore();
      const totalFiles = new Set(vectorStoreSnapshot.map((v) => v.file)).size;
      const totalChunksCount = vectorStoreSnapshot.length;

      if (this.config.clearCacheAfterIndex) {
        console.info(
          '[Indexer] clearCacheAfterIndex enabled; in-memory vectors will be reloaded on next query'
        );
        await this.cache.dropInMemoryVectors();
        if (this.config.verbose) {
          console.info('[Cache] Cleared in-memory vectors after indexing');
        }
      }

      // Unload embedding models to free RAM
      if (this.config.unloadModelAfterIndex) {
        console.info(
          '[Indexer] unloadModelAfterIndex enabled; embedding model will be reloaded on next query'
        );
        await this.unloadEmbeddingModels();
      }

      // Rebuild call graph in background
      if (this.config.callGraphEnabled) {
        this.cache.rebuildCallGraph();
      }

      if (!this.config.clearCacheAfterIndex) {
        void this.cache.ensureAnnIndex().catch((error) => {
          if (this.config.verbose) {
            console.warn(`[ANN] Background ANN build failed: ${error.message}`);
          }
        });
      }

      return {
        skipped: false,
        filesProcessed: filesToProcess.length,
        chunksCreated: totalChunks,
        totalFiles,
        totalChunks: totalChunksCount,
        duration: totalTime,
        message: `Indexed ${filesToProcess.length} files (${totalChunks} chunks) in ${totalTime}s`,
      };
    } finally {
      if (memoryTimer) {
        clearInterval(memoryTimer);
      }
      if (this._embeddingProcessSessionActive) {
        await this.stopEmbeddingProcessSession();
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
    // Prevent unbounded memory growth during rapid file churn (e.g., build processes)
    if (this.pendingWatchEvents.size >= MAX_PENDING_WATCH_EVENTS) {
      console.warn(
        `[Indexer] pendingWatchEvents limit reached (${MAX_PENDING_WATCH_EVENTS}), ` +
        `trimming oldest ${this.pendingWatchEvents.size - PENDING_WATCH_EVENTS_TRIM_SIZE} events`
      );
      // Drop oldest events (Map iterates in insertion order)
      const toRemove = this.pendingWatchEvents.size - PENDING_WATCH_EVENTS_TRIM_SIZE;
      let count = 0;
      for (const key of this.pendingWatchEvents.keys()) {
        if (count++ >= toRemove) break;
        this.pendingWatchEvents.delete(key);
      }
    }

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
      if (typeof this.cache.ensureLoaded === 'function') {
        await this.cache.ensureLoaded();
      }

      while (this.pendingWatchEvents.size > 0) {
        const pending = Array.from(this.pendingWatchEvents.entries());
        this.pendingWatchEvents.clear();

        for (const [filePath, type] of pending) {
          if (this.server && this.server.hybridSearch) {
            this.server.hybridSearch.clearFileModTime(filePath);
          }

          if (type === 'unlink') {
            await this.cache.removeFileFromStore(filePath);
            this.cache.deleteFileHash(filePath);
          } else {
            await this.indexFile(filePath);
          }
        }

        await this.cache.save();
        if (this.config.clearCacheAfterIndex) {
          await this.cache.dropInMemoryVectors();
        }
        this.maybeRunIncrementalGc('watch batch');
      }
    } finally {
      this.processingWatchEvents = false;
    }
  }

  /**
   * Debounced file indexing for watcher events.
   * Consolidates rapid add/change events and prevents concurrent indexing of the same file.
   */
  debouncedWatchIndexFile(fullPath, eventType) {
    // Cancel any pending debounce timer for this file
    const existingTimer = this._watcherDebounceTimers.get(fullPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // If file is currently being indexed, just schedule a re-index after it completes
    if (this._watcherInProgress.has(fullPath)) {
      // Schedule a follow-up reindex after current one completes
      this._watcherPendingReindex.set(fullPath, eventType);
      if (this.config.verbose) {
        console.info(
          `[Indexer] Skipping duplicate ${eventType} for ${path.basename(fullPath)} (already indexing)`
        );
      }
      return;
    }

    // Set a debounce timer to consolidate rapid events
    const timer = setTimeout(async () => {
      this._watcherDebounceTimers.delete(fullPath);

      // Mark file as in-progress
      const indexPromise = (async () => {
        try {
          // Invalidate recency cache
          if (this.server && this.server.hybridSearch) {
            this.server.hybridSearch.clearFileModTime(fullPath);
          }

          await this.indexFile(fullPath);
          await this.cache.save();
          if (this.config.clearCacheAfterIndex) {
            await this.cache.dropInMemoryVectors();
          }
          this.maybeRunIncrementalGc(`watch ${eventType}`);
        } catch (err) {
          console.warn(`[Indexer] Failed to index ${path.basename(fullPath)}: ${err.message}`);
        } finally {
          this._watcherInProgress.delete(fullPath);
          const pendingType = this._watcherPendingReindex.get(fullPath);
          if (pendingType) {
            this._watcherPendingReindex.delete(fullPath);
            this.debouncedWatchIndexFile(fullPath, pendingType);
          }
        }
      })();

      this._watcherInProgress.set(fullPath, indexPromise);
    }, this._watcherDebounceMs);

    this._watcherDebounceTimers.set(fullPath, timer);
  }

  async setupFileWatcher() {
    if (!this.config.watchFiles) return;

    // Close existing watcher if active to prevent leaks
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    await this.loadGitignore();

    const pattern = [
      ...this.config.fileExtensions.map((ext) => `**/*.${ext}`),
      ...(this.config.fileNames || []).map((name) => `**/${name}`),
    ];

    const ignored = (filePath) => {
      const fullPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(this.config.searchDirectory, filePath);
      const isIgnored = this.isExcluded(fullPath);
      if (isIgnored && this.config.verbose) {
        if (!this._watcherIgnoredLogCount) {
          this._watcherIgnoredLogCount = 0;
          this._watcherIgnoredLastLogAt = 0;
        }
        const now = Date.now();
        const shouldLog =
          this._watcherIgnoredLogCount < 5 || now - this._watcherIgnoredLastLogAt > 2000;
        if (shouldLog) {
          this._watcherIgnoredLogCount += 1;
          this._watcherIgnoredLastLogAt = now;
          console.info(`[Indexer] Watcher ignored: ${fullPath}`);
        }
      }
      return isIgnored;
    };

    const awaitWriteFinish =
      this._watcherWriteStabilityMs > 0
        ? {
            stabilityThreshold: this._watcherWriteStabilityMs,
            pollInterval: 100,
          }
        : undefined;

    this.watcher = chokidar.watch(pattern, {
      cwd: this.config.searchDirectory,
      ignored,
      persistent: true,
      ignoreInitial: true,
      ...(awaitWriteFinish ? { awaitWriteFinish } : {}),
    });

    this.watcher
      .on('add', (filePath) => {
        const fullPath = path.join(this.config.searchDirectory, filePath);
        console.info(`[Indexer] New file detected: ${filePath}`);

        // Invalidate recency cache for consistency
        if (this.server && this.server.hybridSearch) {
          this.server.hybridSearch.clearFileModTime(fullPath);
        }

        if (this.isIndexing || this.processingWatchEvents) {
          if (this.config.verbose) {
            console.info(`[Indexer] Queued add event during indexing: ${filePath}`);
          }
          this.enqueueWatchEvent('add', fullPath);
          return;
        }

        // Use debounced indexing to consolidate rapid add/change events
        this.debouncedWatchIndexFile(fullPath, 'add');
      })
      .on('change', (filePath) => {
        const fullPath = path.join(this.config.searchDirectory, filePath);
        console.info(`[Indexer] File changed: ${filePath}`);

        // Invalidate recency cache for consistency
        if (this.server && this.server.hybridSearch) {
          this.server.hybridSearch.clearFileModTime(fullPath);
        }

        if (this.isIndexing || this.processingWatchEvents) {
          if (this.config.verbose) {
            console.info(`[Indexer] Queued change event during indexing: ${filePath}`);
          }
          this.enqueueWatchEvent('change', fullPath);
          return;
        }

        // Use debounced indexing to consolidate rapid add/change events
        this.debouncedWatchIndexFile(fullPath, 'change');
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

        if (typeof this.cache.ensureLoaded === 'function') {
          await this.cache.ensureLoaded();
        }
        await this.cache.removeFileFromStore(fullPath);
        this.cache.deleteFileHash(fullPath);
        await this.cache.save();
        if (this.config.clearCacheAfterIndex) {
          await this.cache.dropInMemoryVectors();
        }
        this.maybeRunIncrementalGc('watch unlink');
      })
      .on('ready', () => {
        console.info('[Indexer] File watcher ready and monitoring for changes');
        if (this.config.verbose) {
          console.info(`[Indexer] Watch root: ${this.config.searchDirectory || 'unknown'}`);
          console.info(`[Indexer] Watch patterns: ${pattern.length}`);
          console.info(
            `[Indexer] Watching extensions: ${this.config.fileExtensions?.length || 0} types`
          );
          console.info(
            `[Indexer] Watching fileNames: ${(this.config.fileNames || []).join(', ') || 'none'}`
          );
          console.info(
            `[Indexer] Exclude patterns: ${(this.config.excludePatterns || []).length} patterns`
          );
          console.info('[Indexer] ignoreInitial: true');
        }
      })
      .on('error', (error) => {
        console.error(`[Indexer] File watcher error: ${error.message}`);
        if (this.config.verbose) {
          console.error(`[Indexer] Watcher error details:`, error);
        }
      });

    console.info('[Indexer] File watcher starting...');
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
