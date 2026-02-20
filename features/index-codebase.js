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
import { forceShutdownEmbeddingPool, isEmbeddingPoolActive } from '../lib/embed-query-process.js';

import ignore from 'ignore';

import { sliceAndNormalize, toFloat32Array } from '../lib/slice-normalize.js';
import {
  EMBEDDING_PROCESS_DEFAULT_GC_MAX_REQUESTS_WITHOUT_COLLECTION,
  EMBEDDING_PROCESS_DEFAULT_GC_MIN_INTERVAL_MS,
  EMBEDDING_PROCESS_DEFAULT_GC_RSS_THRESHOLD_MB,
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

    this._watcherDebounceTimers = new Map();

    this._watcherInProgress = new Map();

    this._watcherPendingReindex = new Map();

    this._watcherDebounceMs = Number.isInteger(this.config.watchDebounceMs)
      ? this.config.watchDebounceMs
      : 300;

    this._watcherWriteStabilityMs = Number.isInteger(this.config.watchWriteStabilityMs)
      ? this.config.watchWriteStabilityMs
      : 1500;

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
    this._lastHighRssRecycleAt = 0;
    this._pendingHighRssRecycleTimer = null;
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

  getIndexCheckpointIntervalMs() {
    const raw = Number(this.config.indexCheckpointIntervalMs);
    if (!Number.isFinite(raw)) return 15000;
    if (raw <= 0) return 0;
    return Math.floor(raw);
  }

  getEmbeddingProcessGcConfig() {
    const thresholdRaw = Number(this.config.embeddingProcessGcRssThresholdMb);
    const minIntervalRaw = Number(this.config.embeddingProcessGcMinIntervalMs);
    const maxRequestsRaw = Number(this.config.embeddingProcessGcMaxRequestsWithoutCollection);
    const gcRssThresholdMb =
      Number.isFinite(thresholdRaw) && thresholdRaw > 0
        ? thresholdRaw
        : EMBEDDING_PROCESS_DEFAULT_GC_RSS_THRESHOLD_MB;
    const gcMinIntervalMs =
      Number.isFinite(minIntervalRaw) && minIntervalRaw >= 0
        ? Math.floor(minIntervalRaw)
        : EMBEDDING_PROCESS_DEFAULT_GC_MIN_INTERVAL_MS;
    const gcMaxRequestsWithoutCollection =
      Number.isFinite(maxRequestsRaw) && maxRequestsRaw > 0
        ? Math.floor(maxRequestsRaw)
        : EMBEDDING_PROCESS_DEFAULT_GC_MAX_REQUESTS_WITHOUT_COLLECTION;
    return { gcRssThresholdMb, gcMinIntervalMs, gcMaxRequestsWithoutCollection };
  }

  shouldPreferDiskCacheLoad() {
    if (!this.config.clearCacheAfterIndex) return false;
    return this.config.vectorStoreFormat === 'binary' || this.config.vectorStoreFormat === 'sqlite';
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

  shouldTraceIncrementalMemory() {
    return this.config.incrementalMemoryProfile === true;
  }

  formatMemoryUsage(usage = process.memoryUsage()) {
    const toMb = (value) => `${(value / 1024 / 1024).toFixed(1)}MB`;
    return (
      `rss=${toMb(usage.rss)} ` +
      `heap=${toMb(usage.heapUsed)}/${toMb(usage.heapTotal)} ` +
      `ext=${toMb(usage.external)} arr=${toMb(usage.arrayBuffers)}`
    );
  }

  async traceIncrementalMemoryPhase(phase, fn) {
    if (!this.shouldTraceIncrementalMemory()) {
      return await fn();
    }
    const startedAt = Date.now();
    const startUsage = process.memoryUsage();
    console.info(`[Indexer][MemTrace] ${phase} start: ${this.formatMemoryUsage(startUsage)}`);
    try {
      return await fn();
    } finally {
      const endUsage = process.memoryUsage();
      const deltaRssMb = (endUsage.rss - startUsage.rss) / 1024 / 1024;
      const deltaHeapMb = (endUsage.heapUsed - startUsage.heapUsed) / 1024 / 1024;
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(2);
      console.info(
        `[Indexer][MemTrace] ${phase} end: ${this.formatMemoryUsage(endUsage)} ` +
          `deltaRss=${deltaRssMb.toFixed(1)}MB deltaHeap=${deltaHeapMb.toFixed(1)}MB elapsed=${elapsedSec}s`
      );
    }
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

  shouldDisableHeavyModelWorkersOnWindows() {
    if (process.platform !== 'win32') return false;
    if (!this.isHeavyEmbeddingModel()) return false;
    return this.config.workerDisableHeavyModelOnWindows !== false;
  }

  getWorkerInferenceBatchSize({ numWorkers = null } = {}) {
    const configured =
      Number.isInteger(this.config.embeddingBatchSize) && this.config.embeddingBatchSize > 0
        ? this.config.embeddingBatchSize
        : null;
    if (configured) return Math.min(configured, 256);

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

  maybeShutdownQueryEmbeddingPool(reason = 'indexing') {
    if (this.config.shutdownQueryEmbeddingPoolAfterIndex === false) return;
    if (!isEmbeddingPoolActive()) return;
    if (this.config.verbose) {
      console.info(`[Indexer] Shutting down search embedding pool after ${reason}`);
    }
    forceShutdownEmbeddingPool();
  }

  maybeRecycleServerAfterIncremental(reason = 'watch update') {
    if (this.config.recycleServerOnHighRssAfterIncremental !== true) return false;

    const thresholdRaw = Number(this.config.recycleServerOnHighRssThresholdMb);
    const thresholdMb = Number.isFinite(thresholdRaw) && thresholdRaw > 0 ? thresholdRaw : 4096;
    const cooldownRaw = Number(this.config.recycleServerOnHighRssCooldownMs);
    const cooldownMs = Number.isFinite(cooldownRaw) && cooldownRaw >= 0 ? cooldownRaw : 300000;
    const delayRaw = Number(this.config.recycleServerOnHighRssDelayMs);
    const delayMs = Number.isFinite(delayRaw) && delayRaw >= 0 ? delayRaw : 2000;

    const now = Date.now();
    if (this._lastHighRssRecycleAt && now - this._lastHighRssRecycleAt < cooldownMs) {
      return false;
    }

    const rssMb = process.memoryUsage().rss / 1024 / 1024;
    if (rssMb < thresholdMb) return false;

    this._lastHighRssRecycleAt = now;
    if (this._pendingHighRssRecycleTimer) {
      clearTimeout(this._pendingHighRssRecycleTimer);
      this._pendingHighRssRecycleTimer = null;
    }

    console.warn(
      `[Indexer] High RSS after ${reason} cleanup (${rssMb.toFixed(1)}MB >= ${thresholdMb}MB); recycling server in ${(delayMs / 1000).toFixed(1)}s`
    );

    this._pendingHighRssRecycleTimer = setTimeout(() => {
      this._pendingHighRssRecycleTimer = null;
      this.runExplicitGc({ force: true });
      const currentRssMb = process.memoryUsage().rss / 1024 / 1024;
      if (currentRssMb < thresholdMb) {
        if (this.config.verbose || this.shouldTraceIncrementalMemory()) {
          console.info(
            `[Indexer] High-RSS recycle canceled after ${reason}; rss dropped to ${currentRssMb.toFixed(1)}MB`
          );
        }
        return;
      }
      console.warn(
        `[Indexer] Recycling server process due to persistent high RSS after ${reason} (${currentRssMb.toFixed(1)}MB)`
      );
      process.exit(0);
    }, delayMs);

    if (typeof this._pendingHighRssRecycleTimer?.unref === 'function') {
      this._pendingHighRssRecycleTimer.unref();
    }
    return true;
  }

  async runPostIncrementalCleanup(reason = 'watch update') {
    if (this.config.clearCacheAfterIndex) {
      await this.traceIncrementalMemoryPhase(
        `incremental.dropInMemoryVectors (${reason})`,
        async () => {
          await this.cache.dropInMemoryVectors();
        }
      );
      if (this.config.verbose) {
        console.info(`[Cache] Cleared in-memory vectors after ${reason}`);
      }

      await this.traceIncrementalMemoryPhase(`incremental.explicitGc (${reason})`, async () => {
        this.runExplicitGc({ force: true });
      });
    } else {
      await this.traceIncrementalMemoryPhase(`incremental.maybeRunGc (${reason})`, async () => {
        this.maybeRunIncrementalGc(reason);
      });
    }
    if (this.config.unloadModelAfterIndex) {
      await this.traceIncrementalMemoryPhase(
        `incremental.unloadEmbeddingModels (${reason})`,
        async () => {
          await this.unloadEmbeddingModels();
        }
      );
    }
    await this.traceIncrementalMemoryPhase(
      `incremental.shutdownQueryPool (${reason})`,
      async () => {
        this.maybeShutdownQueryEmbeddingPool(reason);
      }
    );
    if (this.config.verbose) {
      const { rss, heapUsed, heapTotal } = process.memoryUsage();
      const toMb = (value) => `${(value / 1024 / 1024).toFixed(1)}MB`;
      console.info(
        `[Indexer] Memory after ${reason} cleanup: rss=${toMb(rss)} heap=${toMb(heapUsed)}/${toMb(heapTotal)}`
      );
    }
    this.maybeRecycleServerAfterIncremental(reason);
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

  async initializeWorkers() {
    const activeWorkers = this.workers.filter((w) => w !== null);
    if (activeWorkers.length > 0) return;

    if (this.workers.length > 0) {
      this.workers = [];
      this.workerReady = [];
    }

    if (this.initWorkerPromise) return this.initWorkerPromise;

    this.initWorkerPromise = (async () => {
      try {
        let numWorkers =
          this.config.workerThreads === 'auto'
            ? Math.min(2, Math.max(1, os.cpus().length - 1))
            : typeof this.config.workerThreads === 'number'
              ? this.config.workerThreads
              : 1;

        if (this.shouldDisableHeavyModelWorkersOnWindows() && numWorkers > 0) {
          if (!this._heavyWorkerSafetyLogged) {
            console.warn(
              '[Indexer] Heavy model worker safety mode: disabling workers on Windows to avoid native worker crashes/timeouts'
            );
            this._heavyWorkerSafetyLogged = true;
          }
          numWorkers = 0;
        }

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

        if (!isTestEnv() && typeof os.totalmem === 'function') {
          const totalMemGb = os.totalmem() / 1024 / 1024 / 1024;
          const rssGb = process.memoryUsage().rss / 1024 / 1024 / 1024;
          const isHeavyModel = this.isHeavyEmbeddingModel();
          const memPerWorker = isHeavyModel ? 8.0 : 0.8;
          const projectedGb = rssGb + numWorkers * memPerWorker + 0.5;
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

        const threadsPerWorker = 1;

        console.info(
          `[Indexer] Initializing ${numWorkers} worker threads (${threadsPerWorker} threads per worker)...`
        );

        const workerInferenceBatchSize = this.getWorkerInferenceBatchSize({ numWorkers });
        if (this.config.verbose && Number.isInteger(workerInferenceBatchSize)) {
          console.info(`[Indexer] Worker inference batch size: ${workerInferenceBatchSize}`);
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

  async terminateWorkers() {
    const WORKER_SHUTDOWN_TIMEOUT = isTestEnv() ? 50 : 5000;
    const terminations = this.workers.filter(Boolean).map((worker) => {
      try {
        worker.postMessage({ type: 'shutdown' });
      } catch {}

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
        } catch {}
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

  async unloadEmbeddingModels() {
    const results = { workers: 0, childUnloaded: false };

    if (this.workers.length > 0) {
      if (this.config.verbose) {
        console.info(`[Indexer] Terminating ${this.workers.length} workers to free model memory`);
      }
      await this.terminateWorkers();
      results.workers = this.workers.length;
    }

    if (this._embeddingChild) {
      const childResult = await this.unloadEmbeddingChildModel();
      results.childUnloaded = childResult?.wasLoaded || false;
      if (this.config.verbose) {
        console.info(`[Indexer] Embedding child model unloaded: ${results.childUnloaded}`);
      }
    }

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

  sendProgress(progress, total, message) {
    if (this.server) {
      try {
        this.server.sendNotification('notifications/progress', {
          progressToken: 'indexing',
          progress,
          total,
          message,
        });
      } catch (_err) {}
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
    } catch {}
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

    const makeRetryResults = (files) =>
      files.map((fileEntry) => ({ file: fileEntry.file, status: 'retry' }));

    if (this.workersDisabledUntil && Date.now() < this.workersDisabledUntil) {
      if (this.config.verbose) {
        console.warn(
          `[Indexer] Workers disabled by circuit breaker; routing ${allowedFiles.length} files to main-thread fallback`
        );
      }
      return makeRetryResults(allowedFiles);
    }

    if (this._workerReplacementPromises && this._workerReplacementPromises.size > 0) {
      await Promise.allSettled(this._workerReplacementPromises.values());
    }

    const activeWorkers = this.workers
      .map((worker, index) => ({ worker, index }))
      .filter((entry) => entry.worker);

    if (activeWorkers.length === 0) {
      if (this.config.verbose) {
        console.warn(
          `[Indexer] No active workers available; routing ${allowedFiles.length} files to main-thread fallback`
        );
      }
      return makeRetryResults(allowedFiles);
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
        let workerKilled = false;

        const killWorker = async () => {
          if (workerKilled || this.workers[workerIndex] === null) return;
          workerKilled = true;
          this.workers[workerIndex] = null;
          try {
            await worker.terminate?.();
          } catch (_err) {}

          if (!this._workerReplacementPromises) {
            this._workerReplacementPromises = new Map();
          }
          if (!this._workerReplacementPromises.has(workerIndex)) {
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

        let timeout = null;
        const resetTimeout = () => {
          if (timeout) clearTimeout(timeout);
          timeout = setTimeout(handleTimeout, WORKER_TIMEOUT);
        };

        const handleTimeout = () => {
          void killWorker();
          worker.off('message', handler);
          worker.off('error', errorHandler);
          console.warn(
            `[Indexer] Worker ${workerIndex} timed out (files, no heartbeat for ${Math.round(WORKER_TIMEOUT / 1000)}s)`
          );
          this.recordWorkerFailure(`timeout (batch ${batchId})`);
          resolve([]);
        };

        resetTimeout();

        const finalize = (results) => {
          if (timeout) clearTimeout(timeout);
          worker.off('message', handler);
          worker.off('error', errorHandler);
          resolve(results);
        };

        const handler = (msg) => {
          if (msg.batchId === batchId) {
            if (msg.type === 'progress') {
              resetTimeout();
              return;
            }
            if (msg.type === 'results') {
              if (Array.isArray(msg.results)) {
                batchResults.push(...msg.results);
              }
              if (msg.done) {
                finalize(batchResults);
              } else {
                resetTimeout();
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

    const failedFiles = [];
    for (let i = 0; i < workerResults.length; i++) {
      if (workerResults[i].length > 0) {
        results.push(...workerResults[i]);
      } else if (workerPromises[i].files.length > 0) {
        failedFiles.push(...workerPromises[i].files);
      }
    }

    if (failedFiles.length > 0) {
      if (this.config.verbose) {
        console.warn(
          `[Indexer] ${failedFiles.length} files failed in workers, falling back to main thread`
        );
      }

      for (const f of failedFiles) {
        results.push({ file: f.file, status: 'retry' });
      }
    }

    return results;
  }

  async processChunksWithWorkers(allChunks) {
    const activeWorkers = this.workers
      .map((worker, index) => ({ worker, index }))
      .filter((entry) => entry.worker);

    if (activeWorkers.length === 0) {
      return this.processChunksSingleThreaded(allChunks);
    }

    const results = [];
    const allowSingleThreadFallback = this.config.allowSingleThreadFallback !== false;
    const chunkSize = Math.ceil(allChunks.length / activeWorkers.length);
    const workerPromises = [];
    const configuredTimeout = Number.isInteger(this.config.workerBatchTimeoutMs)
      ? this.config.workerBatchTimeoutMs
      : 300000;
    const WORKER_TIMEOUT = isTestEnv() ? 1000 : configuredTimeout;

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
        let workerKilled = false;

        const killWorker = async () => {
          if (workerKilled || this.workers[workerIndex] === null) return;
          workerKilled = true;
          this.workers[workerIndex] = null;
          try {
            await worker.terminate?.();
          } catch {}

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
          void killWorker();
          worker.off('message', handler);
          worker.off('error', errorHandler);
          if (exitHandler) worker.off('exit', exitHandler);
          console.warn(`[Indexer] Worker ${workerIndex} timed out, ${label}`);
          this.recordWorkerFailure(`timeout (batch ${batchId})`);

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

    const workerResults = await Promise.all(workerPromises.map((p) => p.promise));

    const failedChunks = [];
    for (let i = 0; i < workerResults.length; i++) {
      if (workerResults[i].length > 0) {
        results.push(...workerResults[i]);
      } else if (workerPromises[i].chunks.length > 0) {
        failedChunks.push(...workerPromises[i].chunks);
      }
    }

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
        EMBEDDING_PROCESS_RUN_MAIN: 'true',
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
    } catch {}
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
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
      ...this.getEmbeddingProcessGcConfig(),
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
        } catch {}
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
      ...this.getEmbeddingProcessGcConfig(),
    };

    return new Promise((resolve) => {
      const startedAt = Date.now();
      const child = spawn(nodePath, ['--expose-gc', scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          EMBEDDING_PROCESS_RUN_MAIN: 'true',
        },
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
        } catch {}
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

          stdout = '';
          stderr = '';
          resolve(this.applyEmbeddingDimensionToResults(parsed?.results || []));
        } catch (err) {
          stdout = '';
          stderr = '';
          this.recordWorkerFailure(`child process parse error (${err.message})`);
          resolve([]);
        }
      });

      child.stdin.end(JSON.stringify(payload));
    });
  }

  async processChunksSingleThreaded(chunks) {
    const results = [];

    let processedSinceGc = 0;

    for (const chunk of chunks) {
      await delay(0);

      try {
        const output = await this.embedder(chunk.text, {
          pooling: 'mean',
          normalize: true,
        });

        let vector = toFloat32Array(output.data);
        if (this.config.embeddingDimension) {
          vector = sliceAndNormalize(vector, this.config.embeddingDimension);
        }

        if (typeof output.dispose === 'function') {
          try {
            output.dispose();
          } catch {}
        }
        results.push({
          file: chunk.file,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.text,
          vector,
          success: true,
        });

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
    const fileName = path.basename(file);
    if (typeof this.cache.ensureLoaded === 'function') {
      const preferDisk = this.shouldPreferDiskCacheLoad();
      await this.traceIncrementalMemoryPhase(`indexFile.ensureLoaded (${fileName})`, async () => {
        await this.cache.ensureLoaded({ preferDisk });
      });
    }
    if (!(await this.isPathInsideWorkspaceReal(file))) {
      console.warn(`[Indexer] Skipped ${path.basename(file)} (outside workspace)`);
      return 0;
    }
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
      const stats = await fs.stat(file);

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

      const cachedHash =
        typeof this.cache.getFileHash === 'function' ? this.cache.getFileHash(file) : null;
      if (cachedHash === hash) {
        if (this.config.verbose) {
          console.info(`[Indexer] Skipped ${fileName} (unchanged)`);
        }

        this.cache.setFileHash(file, hash, stats);
        return 0;
      }

      if (this.config.verbose) {
        console.info(`[Indexer] Indexing ${fileName}...`);
      }

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

      const results = await this.traceIncrementalMemoryPhase(
        `indexFile.embedChunks (${fileName})`,
        async () => {
          if (useWorkers && this.workers.length > 0) {
            return await this.processChunksWithWorkers(chunksToProcess);
          }
          if (useEmbeddingProcessPerBatch) {
            return await this.processChunksInChildProcess(chunksToProcess);
          }
          return await this.processChunksSingleThreaded(chunksToProcess);
        }
      );

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

      await this.traceIncrementalMemoryPhase(`indexFile.commit (${fileName})`, async () => {
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
      });

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

  async discoverFiles() {
    const startTime = Date.now();

    const extensions = new Set(
      this.config.fileExtensions.map((ext) => `.${String(ext).toLowerCase()}`)
    );
    const allowedFileNames = new Set(this.config.fileNames || []);

    await this.loadGitignore();

    if (!this.config.searchDirectory) {
      return [];
    }

    const api = new fdir()
      .withFullPaths()
      .exclude((dirName, dirPath) => {
        if (dirName === 'node_modules' || dirName === '.git' || dirName === '.smart-coding-cache')
          return true;

        const fullPath = path.join(dirPath, dirName);
        return this.isExcluded(fullPath);
      })
      .filter((filePath) => {
        if (this.isExcluded(filePath)) return false;

        const base = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();
        return extensions.has(ext) || allowedFileNames.has(base);
      })
      .crawl(this.config.searchDirectory);

    const files = await api.withPromise();

    console.info(`[Indexer] File discovery: ${files.length} files in ${Date.now() - startTime}ms`);
    return files;
  }

  async preFilterFiles(files) {
    const startTime = Date.now();
    const filesToProcess = [];
    const skippedCount = { unchanged: 0, tooLarge: 0, error: 0 };

    const STAT_BATCH_SIZE = Math.min(100, this.config.batchSize || 100);

    const MAX_READ_BATCH_BYTES = 50 * 1024 * 1024;

    for (let i = 0; i < files.length; i += STAT_BATCH_SIZE) {
      const batchFiles = files.slice(i, i + STAT_BATCH_SIZE);

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
              const now = Date.now();
              const isRecent = Math.abs(now - mtimeMs) <= mtimeSafeWindowMs;
              if (!isRecent) {
                skippedCount.unchanged++;
                return null;
              }
            }

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
        const intervalMs =
          Number.isInteger(this.config.memoryLogIntervalMs) && this.config.memoryLogIntervalMs >= 0
            ? this.config.memoryLogIntervalMs
            : 30000;
        if (intervalMs > 0) {
          memoryTimer = setInterval(() => logMemory('periodic'), intervalMs);
        }
      }

      if (force) {
        console.info('[Indexer] Force reindex requested: clearing cache');
        await this.cache.reset();
      } else {
        if (typeof this.cache.ensureLoaded === 'function') {
          await this.cache.ensureLoaded({ preferDisk: this.shouldPreferDiskCacheLoad() });
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

      this.sendProgress(5, 100, `Discovered ${files.length} files`);

      const currentFilesSet = new Set(files);

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
        }

        const prunedCallGraph = this.cache.pruneCallGraphData(currentFilesSet);
        if (prunedCallGraph > 0 && this.config.verbose) {
          console.info(`[Indexer] Pruned ${prunedCallGraph} call-graph entries`);
        }
      }

      const filesToProcess = await this.preFilterFiles(files);
      const filesToProcessSet = new Set(filesToProcess.map((entry) => entry.file));
      const filesToProcessByFile = new Map(filesToProcess.map((entry) => [entry.file, entry]));

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

      console.info(`[Indexer] Processing ${filesToProcess.length} changed files`);
      this.sendProgress(10, 100, `Processing ${filesToProcess.length} changed files`);

      let adaptiveBatchSize = 10;
      if (files.length > 500) adaptiveBatchSize = 50;
      if (files.length > 1000) adaptiveBatchSize = 100;
      if (files.length > 5000) adaptiveBatchSize = 500;

      if (this.config.verbose) {
        console.info(
          `[Indexer] Processing ${filesToProcess.length} files (batch size: ${adaptiveBatchSize})`
        );
      }

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
      const checkpointIntervalMs = this.getIndexCheckpointIntervalMs();
      let lastCheckpointSaveAt = Date.now();
      let checkpointSaveCount = 0;

      console.info(
        `[Indexer] Embedding pass started: ${filesToProcess.length} files using ${this.config.embeddingModel}`
      );

      for (let i = 0; i < filesToProcess.length; i += adaptiveBatchSize) {
        const batch = filesToProcess.slice(i, i + adaptiveBatchSize);

        const allChunks = [];
        const fileStats = new Map();
        const newChunksByFile = new Map();
        const callDataByFile = new Map();
        const filesForWorkers = [];

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
            filesForWorkers.push({ file, content: null, force, expectedHash });

            fileStats.set(file, { hash: null, totalChunks: 0, successChunks: 0, size, mtimeMs });
            continue;
          }

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

            fileStats.set(file, {
              hash: liveHash,
              totalChunks: 0,
              successChunks: 0,
              size,
              mtimeMs,
            });
            continue;
          }

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

        if (filesForWorkers.length > 0) {
          const results = await this.processFilesWithWorkers(filesForWorkers);

          for (const res of results) {
            const stats = fileStats.get(res.file);
            if (res.status === 'indexed' && stats) {
              stats.totalChunks = res.results.length;
              stats.successChunks = res.results.length;
              if (res.hash) stats.hash = res.hash;
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
              stats.totalChunks = 0;
              stats.successChunks = 0;
              stats.hash = res.hash;
              this.cache.setFileHash(res.file, res.hash, { size: res.size, mtimeMs: res.mtimeMs });
              if (res.callData && this.config.callGraphEnabled) {
                this.cache.setFileCallData(res.file, res.callData);
              }
            } else if ((res.status === 'retry' || res.status === 'error') && stats) {
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

        if (allChunks.length > 0) {
          const chunksToProcess = allChunks.slice();
          let results = [];
          if (useEmbeddingProcessPerBatch) {
            results = await this.processChunksInChildProcess(chunksToProcess);
          } else {
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

        for (const [file, stats] of fileStats) {
          if (stats.totalChunks > 0 && stats.successChunks === stats.totalChunks) {
            this.cache.removeFileFromStore(file);
            const newChunks = newChunksByFile.get(file) || [];
            for (const chunk of newChunks) {
              this.cache.addToStore(chunk);
              totalChunks++;
            }
            if (typeof stats.hash === 'string' && stats.hash.length > 0) {
              this.cache.setFileHash(file, stats.hash, {
                size: stats.size,
                mtimeMs: stats.mtimeMs,
              });
            } else if (this.config.verbose) {
              console.warn(
                `[Indexer] Skipped hash update for ${path.basename(file)} (missing hash)`
              );
            }
            const callData = callDataByFile.get(file);
            if (callData && this.config.callGraphEnabled) {
              this.cache.setFileCallData(file, callData);
            }
          } else if (stats.totalChunks === 0) {
            if (typeof stats.hash === 'string' && stats.hash.length > 0) {
              this.cache.setFileHash(file, stats.hash, {
                size: stats.size,
                mtimeMs: stats.mtimeMs,
              });
            } else if (this.config.verbose) {
              console.warn(
                `[Indexer] Skipped hash update for ${path.basename(file)} (missing hash)`
              );
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

        const shouldCheckpointSave =
          checkpointIntervalMs > 0 &&
          processedFiles < filesToProcess.length &&
          Date.now() - lastCheckpointSaveAt >= checkpointIntervalMs;
        if (shouldCheckpointSave) {
          await this.traceIncrementalMemoryPhase('indexAll.checkpointSave', async () => {
            await this.cache.save();
          });
          checkpointSaveCount += 1;
          lastCheckpointSaveAt = Date.now();
          if (this.config.verbose) {
            console.info(
              `[Indexer] Checkpoint saved (${processedFiles}/${filesToProcess.length} files processed)`
            );
          }
        }

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

        allChunks.length = 0;
        filesForWorkers.length = 0;
        fileStats.clear();
        newChunksByFile.clear();
        callDataByFile.clear();
        await delay(0);
      }

      if (this.workers.length > 0) {
        await this.terminateWorkers();
      }
      this.runExplicitGc({ force: true });

      const totalDurationMs = Date.now() - totalStartTime;
      const totalTime = (totalDurationMs / 1000).toFixed(1);
      console.info(
        `[Indexer] Embedding pass complete: ${totalChunks} chunks from ${filesToProcess.length} files in ${totalTime}s`
      );

      this.sendProgress(
        95,
        100,
        `Embedding complete; saving cache (${totalChunks} chunks from ${filesToProcess.length} files)...`
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
        lastCheckpointIntervalMs: checkpointIntervalMs,
        lastCheckpointSaves: checkpointSaveCount,
      });
      try {
        await this.cache.save({ throwOnError: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Indexer] Final cache save failed after embedding pass: ${message}`);
        throw error;
      }

      this.sendProgress(
        100,
        100,
        `Complete: ${totalChunks} chunks from ${filesToProcess.length} files in ${totalTime}s`
      );

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

      if (this.config.unloadModelAfterIndex) {
        console.info(
          '[Indexer] unloadModelAfterIndex enabled; embedding model will be reloaded on next query'
        );
        await this.unloadEmbeddingModels();
      }
      this.maybeShutdownQueryEmbeddingPool('full index');

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
    if (this.pendingWatchEvents.size >= MAX_PENDING_WATCH_EVENTS) {
      console.warn(
        `[Indexer] pendingWatchEvents limit reached (${MAX_PENDING_WATCH_EVENTS}), ` +
          `trimming oldest ${this.pendingWatchEvents.size - PENDING_WATCH_EVENTS_TRIM_SIZE} events`
      );

      const toRemove = this.pendingWatchEvents.size - PENDING_WATCH_EVENTS_TRIM_SIZE;
      let count = 0;
      for (const key of this.pendingWatchEvents.keys()) {
        if (count++ >= toRemove) break;
        this.pendingWatchEvents.delete(key);
      }
    }

    if (type === 'unlink') {
      this.pendingWatchEvents.set(filePath, 'unlink');
      return;
    }

    this.pendingWatchEvents.set(filePath, type);
  }

  async processPendingWatchEvents() {
    if (this.processingWatchEvents || this.pendingWatchEvents.size === 0) {
      return;
    }

    this.processingWatchEvents = true;
    try {
      if (typeof this.cache.ensureLoaded === 'function') {
        const preferDisk = this.shouldPreferDiskCacheLoad();
        await this.traceIncrementalMemoryPhase('watchBatch.ensureLoaded', async () => {
          await this.cache.ensureLoaded({ preferDisk });
        });
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

        await this.traceIncrementalMemoryPhase('watchBatch.cacheSave', async () => {
          await this.cache.save();
        });
        await this.traceIncrementalMemoryPhase('watchBatch.cleanup', async () => {
          await this.runPostIncrementalCleanup('watch batch');
        });
      }
    } finally {
      this.processingWatchEvents = false;
    }
  }

  debouncedWatchIndexFile(fullPath, eventType) {
    const existingTimer = this._watcherDebounceTimers.get(fullPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    if (this._watcherInProgress.has(fullPath)) {
      this._watcherPendingReindex.set(fullPath, eventType);
      if (this.config.verbose) {
        console.info(
          `[Indexer] Skipping duplicate ${eventType} for ${path.basename(fullPath)} (already indexing)`
        );
      }
      return;
    }

    const timer = setTimeout(async () => {
      this._watcherDebounceTimers.delete(fullPath);

      const indexPromise = (async () => {
        try {
          if (this.server && this.server.hybridSearch) {
            this.server.hybridSearch.clearFileModTime(fullPath);
          }

          await this.indexFile(fullPath);
          await this.traceIncrementalMemoryPhase(
            `watchSingle.cacheSave (${path.basename(fullPath)})`,
            async () => {
              await this.cache.save();
            }
          );
          await this.traceIncrementalMemoryPhase(
            `watchSingle.cleanup (${path.basename(fullPath)})`,
            async () => {
              await this.runPostIncrementalCleanup(`watch ${eventType}`);
            }
          );
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

        this.debouncedWatchIndexFile(fullPath, 'add');
      })
      .on('change', (filePath) => {
        const fullPath = path.join(this.config.searchDirectory, filePath);
        console.info(`[Indexer] File changed: ${filePath}`);

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

        if (this.server && this.server.hybridSearch) {
          this.server.hybridSearch.clearFileModTime(fullPath);
        }

        if (typeof this.cache.ensureLoaded === 'function') {
          const preferDisk = this.shouldPreferDiskCacheLoad();
          await this.traceIncrementalMemoryPhase(
            `watchUnlink.ensureLoaded (${filePath})`,
            async () => {
              await this.cache.ensureLoaded({ preferDisk });
            }
          );
        }
        await this.cache.removeFileFromStore(fullPath);
        this.cache.deleteFileHash(fullPath);
        await this.traceIncrementalMemoryPhase(`watchUnlink.cacheSave (${filePath})`, async () => {
          await this.cache.save();
        });
        await this.traceIncrementalMemoryPhase(`watchUnlink.cleanup (${filePath})`, async () => {
          await this.runPostIncrementalCleanup('watch unlink');
        });
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

export async function handleToolCall(request, indexer) {
  const force = request.params.arguments?.force || false;
  const result = await indexer.indexAll(force);

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
