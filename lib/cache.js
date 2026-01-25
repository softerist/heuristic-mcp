import fs from 'fs/promises';
import path from 'path';
import { Worker } from 'worker_threads';
import { StreamingJsonWriter } from './json-writer.js';

const CACHE_META_VERSION = 1;
const CACHE_META_FILE = 'meta.json';

// ANN meta version stays at 1 for compatibility; maxElements is optional.
const ANN_META_VERSION = 1;
const ANN_INDEX_FILE = 'ann-index.bin';
const ANN_META_FILE = 'ann-meta.json';

const CALL_GRAPH_FILE = 'call-graph.json';

const DEFAULT_JSON_WORKER_THRESHOLD = 5 * 1024 * 1024;
const IS_TEST_ENV = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

// Yield to event loop to keep IDE/extension host responsive during heavy CPU loops
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

let hnswlibPromise = null;
let hnswlibLoadError = null;

async function parseJsonInWorker(filePath) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL('./json-worker.js', import.meta.url), {
      workerData: { filePath },
    });

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      worker.removeAllListeners();
      const termination = worker.terminate?.();
      if (termination && typeof termination.catch === 'function') termination.catch(() => null);
      handler(value);
    };

    worker.once('message', (msg) => {
      if (msg?.ok) {
        finish(resolve, msg.data);
      } else {
        const err = new Error(msg?.error || 'JSON worker failed');
        console.warn(`[Cache] ${err.message}`);
        finish(reject, err);
      }
    });

    worker.once('error', (err) => {
      console.error(`[Cache] JSON worker error: ${err.message}`);
      finish(reject, err);
    });

    worker.once('exit', (code) => {
      if (code !== 0) {
        const err = new Error(`JSON worker exited with code ${code}`);
        console.error(`[Cache] ${err.message}`);
        finish(reject, err);
      }
    });
  });
}

async function readJsonFile(filePath, { workerThresholdBytes = DEFAULT_JSON_WORKER_THRESHOLD } = {}) {
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    return null;
  }

  try {
    const canUseWorker = typeof Worker === 'function';
    const useWorker =
      canUseWorker && stats && typeof stats.size === 'number'
        ? stats.size >= workerThresholdBytes
        : false;

    if (useWorker) return await parseJsonInWorker(filePath);

    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.warn(`[Cache] Failed to parse ${path.basename(filePath)}: ${error.message}`);
    return null;
  }
}

async function loadHnswlib() {
  if (hnswlibLoadError) return null;

  if (!hnswlibPromise) {
    hnswlibPromise = import('hnswlib-node')
      .then((mod) => {
        const HierarchicalNSW = mod?.HierarchicalNSW || mod?.default?.HierarchicalNSW;
        if (!HierarchicalNSW) throw new Error('HierarchicalNSW export not found');
        return HierarchicalNSW;
      })
      .catch((err) => {
        hnswlibLoadError = err;
        console.warn(`[ANN] hnswlib-node unavailable, using linear search (${err.message})`);
        return null;
      });
  }

  return hnswlibPromise;
}

function initHnswIndex(index, maxElements, m, efConstruction) {
  try {
    index.initIndex(maxElements, m, efConstruction, 100);
    return;
  } catch {
    /* ignore */
  }
  try {
    index.initIndex(maxElements, m, efConstruction);
    return;
  } catch {
    /* ignore */
  }
  index.initIndex(maxElements);
}

function readHnswIndex(index, filePath, maxElements) {
  try {
    index.readIndexSync(filePath, maxElements);
    return true;
  } catch {
    /* ignore */
  }
  try {
    index.readIndexSync(filePath);
    return true;
  } catch {
    /* ignore */
  }
  return false;
}

function normalizeLabels(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  const labels = result.labels || result.neighbors || result.indices;
  return labels ? Array.from(labels) : [];
}

function ensureFloat32(vector) {
  if (!vector) return null;
  if (vector instanceof Float32Array) return vector;

  // Convert values (do NOT reinterpret bytes)
  if (ArrayBuffer.isView(vector)) {
    return Float32Array.from(vector);
  }

  return new Float32Array(vector);
}

function normalizeChunkVector(chunk) {
  if (chunk?.vector) chunk.vector = ensureFloat32(chunk.vector);
}

function computeAnnCapacity(total, config) {
  const factor = typeof config.annCapacityFactor === 'number' ? config.annCapacityFactor : 1.2;
  const extra = Number.isInteger(config.annCapacityExtra) ? config.annCapacityExtra : 1024;
  const byFactor = Math.ceil(total * factor);
  const byExtra = total + extra;
  return Math.max(total, byFactor, byExtra);
}

export class EmbeddingsCache {
  constructor(config) {
    this.config = config;

    this.vectorStore = [];
    this.fileHashes = new Map();
    this.isSaving = false;

    this.cacheMeta = {
      version: CACHE_META_VERSION,
      embeddingModel: config.embeddingModel,
    };

    // Save coalescing / debounce (serialized via saveQueue)
    this.saveQueue = Promise.resolve();
    this._saveTimer = null;
    this._saveRequested = false;
    this._savePromise = null;

    // ANN state
    this.annIndex = null;
    this.annMeta = null;
    this.annDirty = false; // needs rebuild
    this.annPersistDirty = false; // in-memory differs from disk
    this.annLoading = null;
    this.annVectorCache = null;

    // Call graph
    this.fileCallData = new Map();
    this.callGraph = null;
    this._callGraphBuild = null;
  }

  // -------------------- Load --------------------

  async load() {
    if (!this.config.enableCache) return;

    try {
      await fs.mkdir(this.config.cacheDirectory, { recursive: true });

      const cacheFile = path.join(this.config.cacheDirectory, 'embeddings.json');
      const hashFile = path.join(this.config.cacheDirectory, 'file-hashes.json');
      const metaFile = path.join(this.config.cacheDirectory, CACHE_META_FILE);

      const workerThresholdBytes =
        Number.isInteger(this.config.jsonWorkerThresholdBytes) &&
        this.config.jsonWorkerThresholdBytes > 0
          ? this.config.jsonWorkerThresholdBytes
          : DEFAULT_JSON_WORKER_THRESHOLD;

      // In tests, read cache files eagerly to exercise worker paths.
      let cacheData = null;
      let hashData = null;
      let prefetched = false;
      if (IS_TEST_ENV) {
        prefetched = true;
        [cacheData, hashData] = await Promise.all([
          readJsonFile(cacheFile, { workerThresholdBytes }),
          readJsonFile(hashFile, { workerThresholdBytes }),
        ]);
      }

      // Read meta first to avoid parsing huge cache files when invalid
      const metaData = await fs.readFile(metaFile, 'utf-8').catch(() => null);
      if (!metaData) {
        console.warn('[Cache] Missing cache metadata, ignoring cache');
        return;
      }

      let meta;
      try {
        meta = JSON.parse(metaData);
      } catch {
        console.warn('[Cache] Invalid cache metadata, ignoring cache');
        console.error('[Cache] Invalid cache metadata, ignoring cache');
        return;
      }

      if (meta?.version !== CACHE_META_VERSION) {
        console.warn(`[Cache] Cache version mismatch (${meta?.version}), ignoring cache`);
        return;
      }

      if (meta?.embeddingModel !== this.config.embeddingModel) {
        console.warn(
          `[Cache] Embedding model changed, ignoring cache (${meta?.embeddingModel} -> ${this.config.embeddingModel})`,
        );
        return;
      }

      if (!prefetched) {
        [cacheData, hashData] = await Promise.all([
          readJsonFile(cacheFile, { workerThresholdBytes }),
          readJsonFile(hashFile, { workerThresholdBytes }),
        ]);
      }

      this.cacheMeta = meta;

      if (cacheData && hashData) {
        const allowedExtensions = new Set((this.config.fileExtensions || []).map((ext) => `.${ext}`));

        const rawHashes = new Map(Object.entries(hashData));
        this.vectorStore = [];
        this.fileHashes.clear();

        // Single-pass filter + normalization
        for (const chunk of cacheData) {
          const ext = path.extname(chunk.file);
          if (!allowedExtensions.has(ext)) continue;
          normalizeChunkVector(chunk);
          this.vectorStore.push(chunk);
        }
        const filteredCount = cacheData.length - this.vectorStore.length;
        if (filteredCount > 0 && this.config.verbose) {
          console.log(`[Cache] Filtered ${filteredCount} outdated cache entries`);
        }

        // Only keep hashes for allowed extensions
        for (const [file, hash] of rawHashes) {
          if (allowedExtensions.has(path.extname(file))) {
            this.fileHashes.set(file, hash);
          }
        }

        if (this.config.verbose) {
          console.log(`[Cache] Loaded ${this.vectorStore.length} cached embeddings`);
        }

        // ANN index is lazily loaded/built on first query
        this.annDirty = false;
        this.annPersistDirty = false;
        this.annIndex = null;
        this.annMeta = null;
        this.annVectorCache = null;
      }

      // Load call-graph data if it exists
      const callGraphFile = path.join(this.config.cacheDirectory, CALL_GRAPH_FILE);
      try {
        const callGraphData = await fs.readFile(callGraphFile, 'utf8');
        const parsed = JSON.parse(callGraphData);
        this.fileCallData = new Map(Object.entries(parsed));
        if (this.config.verbose) {
          console.log(`[Cache] Loaded call-graph data for ${this.fileCallData.size} files`);
        }
      } catch {
        // no cache yet, OK
      }
    } catch (error) {
      console.warn('[Cache] Failed to load cache:', error.message);
    }
  }

  // -------------------- Save (debounced + serialized) --------------------

  save() {
    if (!this.config.enableCache) return Promise.resolve();

    this._saveRequested = true;

    if (this._saveTimer) return this._savePromise ?? Promise.resolve();

    const debounceMs = Number.isInteger(this.config.saveDebounceMs)
      ? this.config.saveDebounceMs
      : 250;

    this._savePromise = new Promise((resolve, reject) => {
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;

        this.saveQueue = this.saveQueue
          .then(async () => {
            while (this._saveRequested) {
              this._saveRequested = false;
              await this.performSave();
            }
          })
          .then(resolve, reject)
          .finally(() => {
            this._savePromise = null;
          });
      }, debounceMs);
    });

    return this._savePromise;
  }

  async performSave() {
    this.isSaving = true;

    try {
      await fs.mkdir(this.config.cacheDirectory, { recursive: true });

      const cacheFile = path.join(this.config.cacheDirectory, 'embeddings.json');
      const hashFile = path.join(this.config.cacheDirectory, 'file-hashes.json');
      const metaFile = path.join(this.config.cacheDirectory, CACHE_META_FILE);

      // Avoid O(N) uniqueFiles scan: fileHashes tracks per-file entries already
      this.cacheMeta = {
        version: CACHE_META_VERSION,
        embeddingModel: this.config.embeddingModel,
        lastSaveTime: new Date().toISOString(),
        filesIndexed: this.fileHashes.size,
        chunksStored: this.vectorStore.length,
        workspace: this.config.searchDirectory || null,
      };

      const vectorWriter = new StreamingJsonWriter(cacheFile, {
        highWaterMark: this.config.cacheWriteHighWaterMark ?? 256 * 1024,
        floatDigits:
          this.config.cacheVectorFloatDigits === undefined
            ? 6
            : this.config.cacheVectorFloatDigits,
        flushChars: this.config.cacheVectorFlushChars ?? 256 * 1024,
        indent: '', // set to "  " if you prefer pretty formatting
        assumeFinite: this.config.cacheVectorAssumeFinite,
        checkFinite: this.config.cacheVectorCheckFinite,
        noMutation: this.config.cacheVectorNoMutation ?? false,
        joinThreshold: this.config.cacheVectorJoinThreshold ?? 8192,
        joinChunkSize: this.config.cacheVectorJoinChunkSize ?? 2048,
      });

      await vectorWriter.writeStart();

      // Optional responsiveness yield (only for huge saves)
      const total = this.vectorStore.length;
      const yieldEvery = total >= 50_000 ? 5000 : 0;

      try {
        for (let i = 0; i < total; i++) {
          const pending = vectorWriter.writeItem(this.vectorStore[i]);
          if (pending) await pending;
          if (yieldEvery && i > 0 && i % yieldEvery === 0) await yieldToLoop();
        }
        await vectorWriter.writeEnd();
      } catch (e) {
        vectorWriter.abort(e);
        throw e;
      }

      await Promise.all([
        fs.writeFile(hashFile, JSON.stringify(Object.fromEntries(this.fileHashes), null, 2)),
        fs.writeFile(metaFile, JSON.stringify(this.cacheMeta, null, 2)),
      ]);

      // Save call-graph data (or remove stale cache)
      const callGraphFile = path.join(this.config.cacheDirectory, CALL_GRAPH_FILE);
      if (this.fileCallData.size > 0) {
        await fs.writeFile(
          callGraphFile,
          JSON.stringify(Object.fromEntries(this.fileCallData), null, 2),
        );
      } else {
        await fs.rm(callGraphFile, { force: true });
      }

      // Persist ANN index if it exists and changed in memory
      if (
        this.config.annIndexCache !== false &&
        this.annPersistDirty &&
        this.annIndex &&
        this.annMeta
      ) {
        try {
          const { indexFile, metaFile: annMetaFile } = this.getAnnIndexPaths();
          this.annIndex.writeIndexSync(indexFile);
          await fs.writeFile(annMetaFile, JSON.stringify(this.annMeta, null, 2));
          this.annPersistDirty = false;
          if (this.config.verbose) {
            console.log(`[ANN] Persisted updated ANN index (${this.annMeta.count} vectors)`);
          }
        } catch (error) {
          console.warn(`[ANN] Failed to persist ANN index: ${error.message}`);
        }
      }
    } catch (error) {
      console.warn('[Cache] Failed to save cache:', error.message);
    } finally {
      this.isSaving = false;
    }
  }

  // -------------------- Vector Store API --------------------

  getVectorStore() {
    return this.vectorStore;
  }

  setVectorStore(store) {
    this.vectorStore = store;
    if (Array.isArray(this.vectorStore)) {
      for (const chunk of this.vectorStore) normalizeChunkVector(chunk);
    }
    this.invalidateAnnIndex();
  }

  getFileHash(file) {
    return this.fileHashes.get(file);
  }

  setFileHash(file, hash) {
    this.fileHashes.set(file, hash);
  }

  deleteFileHash(file) {
    this.fileHashes.delete(file);
  }

  removeFileFromStore(file) {
    // In-place compaction to avoid allocating a new large array
    let w = 0;
    for (let r = 0; r < this.vectorStore.length; r++) {
      const chunk = this.vectorStore[r];
      if (chunk.file !== file) this.vectorStore[w++] = chunk;
    }
    this.vectorStore.length = w;

    // Removing shifts labels => rebuild ANN
    this.invalidateAnnIndex();
    this.removeFileCallData(file);
  }

  addToStore(chunk) {
    normalizeChunkVector(chunk);

    const label = this.vectorStore.length;
    this.vectorStore.push(chunk);
    if (Array.isArray(this.annVectorCache) && this.annVectorCache.length === label) {
      this.annVectorCache.push(chunk.vector);
    }

    // Best-effort incremental ANN append (fast path)
    if (
      this.annIndex &&
      !this.annDirty &&
      this.annMeta &&
      typeof this.annIndex.addPoint === 'function' &&
      this.annMeta.count === label &&
      this.annMeta.maxElements > this.annMeta.count
    ) {
      try {
        this.annIndex.addPoint(chunk.vector, label);
        this.annMeta.count += 1;
        this.annPersistDirty = true;
        return;
      } catch {
        // fall through
      }
    }

    this.invalidateAnnIndex();
  }

  invalidateAnnIndex() {
    this.annIndex = null;
    this.annMeta = null;
    this.annDirty = true;
    this.annPersistDirty = false;
    this.annVectorCache = null;
  }

  getAnnVector(index) {
    if (!Array.isArray(this.vectorStore)) return null;
    const chunk = this.vectorStore[index];
    if (!chunk?.vector) return null;

    if (!Array.isArray(this.annVectorCache) || this.annVectorCache.length !== this.vectorStore.length) {
      this.annVectorCache = new Array(this.vectorStore.length);
    }

    const cached = this.annVectorCache[index];
    if (cached) return cached;

    const vec = ensureFloat32(chunk.vector);
    chunk.vector = vec;
    this.annVectorCache[index] = vec;
    return vec;
  }

  getAnnIndexPaths() {
    return {
      indexFile: path.join(this.config.cacheDirectory, ANN_INDEX_FILE),
      metaFile: path.join(this.config.cacheDirectory, ANN_META_FILE),
    };
  }

  // -------------------- ANN --------------------

  async ensureAnnIndex() {
    if (!this.config.annEnabled) return null;
    if (this.vectorStore.length < (this.config.annMinChunks ?? 5000)) return null;
    if (this.annIndex && !this.annDirty) return this.annIndex;
    if (this.annLoading) return this.annLoading;

    this.annLoading = (async () => {
      const HierarchicalNSW = await loadHnswlib();
      if (!HierarchicalNSW) return null;

      const dim = this.vectorStore[0]?.vector?.length;
      if (!dim) return null;

      if (!this.annDirty && this.config.annIndexCache !== false) {
        const loaded = await this.loadAnnIndexFromDisk(HierarchicalNSW, dim);
        if (loaded) return this.annIndex;
      }

      return await this.buildAnnIndex(HierarchicalNSW, dim);
    })();

    const index = await this.annLoading;
    this.annLoading = null;
    return index;
  }

  async loadAnnIndexFromDisk(HierarchicalNSW, dim) {
    const { indexFile, metaFile } = this.getAnnIndexPaths();
    const metaData = await fs.readFile(metaFile, 'utf-8').catch(() => null);
    if (!metaData) return false;

    let meta;
    try {
      meta = JSON.parse(metaData);
    } catch {
      console.warn('[ANN] Invalid ANN metadata, rebuilding');
      return false;
    }

    if (meta?.version !== ANN_META_VERSION) {
      console.warn(`[ANN] ANN index version mismatch (${meta?.version}), rebuilding`);
      return false;
    }

    if (meta?.embeddingModel !== this.config.embeddingModel) {
      console.warn('[ANN] Embedding model changed for ANN index, rebuilding');
      return false;
    }

    if (meta?.dim !== dim || meta?.count !== this.vectorStore.length) {
      console.warn('[ANN] ANN index size mismatch, rebuilding');
      return false;
    }

    if (
      meta?.metric !== this.config.annMetric ||
      meta?.m !== this.config.annM ||
      meta?.efConstruction !== this.config.annEfConstruction
    ) {
      console.warn('[ANN] ANN index config changed, rebuilding');
      return false;
    }

    let maxElements = meta?.maxElements;
    if (!Number.isInteger(maxElements)) {
      maxElements = meta.count;
    } else if (maxElements < meta.count) {
      console.warn('[ANN] ANN capacity invalid, rebuilding');
      return false;
    }

    const index = new HierarchicalNSW(meta.metric, dim);
    const loaded = readHnswIndex(index, indexFile, maxElements);
    if (!loaded) {
      console.warn('[ANN] Failed to load ANN index file, rebuilding');
      return false;
    }

    if (typeof index.setEf === 'function') {
      index.setEf(this.config.annEfSearch);
    }

    this.annIndex = index;
    this.annMeta = { ...meta, maxElements };
    this.annDirty = false;
    this.annPersistDirty = false;

    if (this.config.verbose) {
      console.log(`[ANN] Loaded ANN index (${meta.count} vectors, cap=${maxElements})`);
    }
    return true;
  }

  async buildAnnIndex(HierarchicalNSW, dim) {
    const total = this.vectorStore.length;
    if (total === 0) return null;

    try {
      const index = new HierarchicalNSW(this.config.annMetric, dim);

      const maxElements = computeAnnCapacity(total, this.config);
      initHnswIndex(index, maxElements, this.config.annM, this.config.annEfConstruction);

      const yieldEvery = Number.isInteger(this.config.annBuildYieldEvery)
        ? this.config.annBuildYieldEvery
        : 1000;

      for (let i = 0; i < total; i++) {
        const vector = this.getAnnVector(i);
        if (!vector) throw new Error(`Missing vector for ANN index at position ${i}`);
        index.addPoint(vector, i);

        if (yieldEvery > 0 && i > 0 && i % yieldEvery === 0) {
          await yieldToLoop();
        }
      }

      if (typeof index.setEf === 'function') {
        index.setEf(this.config.annEfSearch);
      }

      this.annIndex = index;
      this.annMeta = {
        version: ANN_META_VERSION,
        embeddingModel: this.config.embeddingModel,
        metric: this.config.annMetric,
        dim,
        count: total,
        maxElements,
        m: this.config.annM,
        efConstruction: this.config.annEfConstruction,
        efSearch: this.config.annEfSearch,
      };
      this.annDirty = false;
      this.annPersistDirty = true;

      if (this.config.annIndexCache !== false) {
        try {
          await fs.mkdir(this.config.cacheDirectory, { recursive: true });
          const { indexFile, metaFile } = this.getAnnIndexPaths();
          index.writeIndexSync(indexFile);
          await fs.writeFile(metaFile, JSON.stringify(this.annMeta, null, 2));
          this.annPersistDirty = false;
          if (this.config.verbose) {
            console.log(`[ANN] Saved ANN index (${total} vectors, cap=${maxElements})`);
          }
        } catch (error) {
          console.warn(`[ANN] Failed to save ANN index: ${error.message}`);
        }
      }

      return index;
    } catch (error) {
      console.warn(`[ANN] Failed to build ANN index: ${error.message}`);
      this.annIndex = null;
      this.annMeta = null;
      this.annDirty = true;
      this.annPersistDirty = false;
      return null;
    }
  }

  async queryAnn(queryVector, k) {
    const index = await this.ensureAnnIndex();
    if (!index) return null;

    const qVec = queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector);
    const results = index.searchKnn(qVec, k);
    const labels = normalizeLabels(results);

    if (labels.length === 0) return null;

    const filtered = labels.filter(
      (label) => Number.isInteger(label) && label >= 0 && label < this.vectorStore.length,
    );

    return filtered.length > 0 ? filtered : null;
  }

  async clear() {
    if (!this.config.enableCache) return;

    try {
      await fs.rm(this.config.cacheDirectory, { recursive: true, force: true });
      this.vectorStore = [];
      this.fileHashes = new Map();
      this.invalidateAnnIndex();
      await this.clearCallGraphData();
      if (this.config.verbose) {
        console.log(`[Cache] Cache cleared successfully: ${this.config.cacheDirectory}`);
      }
    } catch (error) {
      console.error('[Cache] Failed to clear cache:', error.message);
      throw error;
    }
  }

  /**
   * Adjust efSearch at runtime for speed/accuracy tradeoff.
   * Higher values = more accurate but slower.
   * @param {number} efSearch - New efSearch value (typically 16-512)
   * @returns {object} Result with success status and current config
   */
  setEfSearch(efSearch) {
    if (typeof efSearch !== 'number' || efSearch < 1 || efSearch > 1000) {
      return {
        success: false,
        error: 'efSearch must be a number between 1 and 1000',
      };
    }

    this.config.annEfSearch = efSearch;

    if (this.annIndex && typeof this.annIndex.setEf === 'function') {
      this.annIndex.setEf(efSearch);
      if (this.annMeta) this.annMeta.efSearch = efSearch;
      this.annPersistDirty = true;
      if (this.config.verbose) {
        console.log(`[ANN] efSearch updated to ${efSearch} (applied to active index)`);
      }
      return { success: true, applied: true, efSearch };
    }

    if (this.config.verbose) {
      console.log(`[ANN] efSearch updated to ${efSearch} (will apply on next index build)`);
    }
    return { success: true, applied: false, efSearch };
  }

  /**
   * Get current ANN index statistics for diagnostics.
   * @returns {object} ANN stats including index state, config, and vector count
   */
  getAnnStats() {
    return {
      enabled: this.config.annEnabled ?? false,
      indexLoaded: this.annIndex !== null,
      dirty: this.annDirty,
      vectorCount: this.vectorStore.length,
      minChunksForAnn: this.config.annMinChunks ?? 5000,
      config: this.annMeta
        ? {
            metric: this.annMeta.metric,
            dim: this.annMeta.dim,
            count: this.annMeta.count,
            m: this.annMeta.m,
            efConstruction: this.annMeta.efConstruction,
            efSearch: this.config.annEfSearch,
          }
        : null,
    };
  }

  // -------------------- Call Graph --------------------

  async clearCallGraphData({ removeFile = false } = {}) {
    this.fileCallData.clear();
    this.callGraph = null;

    if (removeFile && this.config.enableCache) {
      const callGraphFile = path.join(this.config.cacheDirectory, CALL_GRAPH_FILE);
      try {
        await fs.rm(callGraphFile, { force: true });
      } catch (error) {
        if (this.config.verbose) {
          console.warn(`[Cache] Failed to remove call-graph cache: ${error.message}`);
        }
      }
    }
  }

  pruneCallGraphData(validFiles) {
    if (!validFiles || this.fileCallData.size === 0) return 0;

    let pruned = 0;
    for (const file of Array.from(this.fileCallData.keys())) {
      if (!validFiles.has(file)) {
        this.fileCallData.delete(file);
        pruned++;
      }
    }

    if (pruned > 0) this.callGraph = null;
    return pruned;
  }

  setFileCallData(file, data) {
    this.fileCallData.set(file, data);
    this.callGraph = null;
  }

  getFileCallData(file) {
    return this.fileCallData.get(file);
  }

  removeFileCallData(file) {
    this.fileCallData.delete(file);
    this.callGraph = null;
  }

  async rebuildCallGraph() {
    if (this._callGraphBuild) return this._callGraphBuild;

    this._callGraphBuild = (async () => {
      try {
        const { buildCallGraph } = await import('./call-graph.js');
        this.callGraph = buildCallGraph(this.fileCallData);
        if (this.config.verbose && this.callGraph) {
          console.log(
            `[CallGraph] Built graph: ${this.callGraph.defines.size} definitions, ${this.callGraph.calledBy.size} call targets`,
          );
          console.error(
            `[CallGraph] Built graph: ${this.callGraph.defines.size} definitions, ${this.callGraph.calledBy.size} call targets`,
          );
        }
      } catch (err) {
        console.error(`[CallGraph] Failed to build: ${err.message}`);
        this.callGraph = null;
      } finally {
        this._callGraphBuild = null;
      }
    })();

    return this._callGraphBuild;
  }

  async getRelatedFiles(symbols) {
    if (!this.config.callGraphEnabled || symbols.length === 0) return new Map();
    if (!this.callGraph && this.fileCallData.size > 0) await this.rebuildCallGraph();
    if (!this.callGraph) return new Map();

    const { getRelatedFiles } = await import('./call-graph.js');
    return getRelatedFiles(this.callGraph, symbols, this.config.callGraphMaxHops);
  }

  getCallGraphStats() {
    return {
      enabled: this.config.callGraphEnabled ?? false,
      filesWithData: this.fileCallData.size,
      graphBuilt: this.callGraph !== null,
      definitions: this.callGraph?.defines.size ?? 0,
      callTargets: this.callGraph?.calledBy.size ?? 0,
    };
  }
}
