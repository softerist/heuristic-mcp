import fs from 'fs/promises';
import path from 'path';
import { Worker } from 'worker_threads';
import { StreamingJsonWriter } from './json-writer.js';

const CACHE_META_VERSION = 1;
const CACHE_META_FILE = 'meta.json';
const ANN_META_VERSION = 1;
const ANN_INDEX_FILE = 'ann-index.bin';
const ANN_META_FILE = 'ann-meta.json';
const CALL_GRAPH_FILE = 'call-graph.json';
const JSON_WORKER_THRESHOLD = 5 * 1024 * 1024;

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
      if (termination && typeof termination.catch === 'function') {
        termination.catch(() => null);
      }
      handler(value);
    };

    worker.once('message', (msg) => {
      if (msg?.ok) {
        finish(resolve, msg.data);
      } else {
        console.warn(`[Cache] ${msg?.error || 'JSON worker failed'}`);
        finish(reject, new Error(msg?.error || 'JSON worker failed'));
      }
    });
    worker.once('error', (err) => {
      console.error(`[Cache] JSON worker error: ${err.message}`);
      finish(reject, err);
    });
    worker.once('exit', (code) => {
      if (code !== 0) {
        const error = new Error(`JSON worker exited with code ${code}`);
        console.error(`[Cache] ${error.message}`);
        finish(reject, error);
      }
    });
  });
}

async function readJsonFile(filePath) {
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    return null;
  }

  try {
    const canUseWorker = typeof Worker === 'function';
    const useWorker = canUseWorker && !!stats && typeof stats.size === 'number'
      ? stats.size >= JSON_WORKER_THRESHOLD
      : false;
    if (useWorker) {
      return await parseJsonInWorker(filePath);
    }
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.warn(
      `[Cache] Failed to parse ${path.basename(filePath)}: ${error.message}`,
    );
    console.error(
      `[Cache] Failed to parse ${path.basename(filePath)}: ${error.message}`,
    );
    return null;
  }
}

async function loadHnswlib() {
  if (hnswlibLoadError) return null;
  if (!hnswlibPromise) {
    hnswlibPromise = import('hnswlib-node')
      .then((mod) => {
        const HierarchicalNSW = mod?.HierarchicalNSW || mod?.default?.HierarchicalNSW;
        if (!HierarchicalNSW) {
          throw new Error('HierarchicalNSW export not found');
        }
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
  } catch { /* ignore */ }
  try {
    index.initIndex(maxElements, m, efConstruction);
    return;
  } catch { /* ignore */ }
  index.initIndex(maxElements);
}

function readHnswIndex(index, filePath, maxElements) {
  try {
    index.readIndexSync(filePath, maxElements);
    return true;
  } catch { /* ignore */ }
  try {
    index.readIndexSync(filePath);
    return true;
  } catch { /* ignore */ }
  return false;
}

function normalizeLabels(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  const labels = result.labels || result.neighbors || result.indices;
  if (labels) {
    return Array.from(labels);
  }
  return [];
}

function toFloat32Array(vector) {
  if (vector instanceof Float32Array) {
    return vector;
  }
  return Float32Array.from(vector);
}

function normalizeChunkVector(chunk) {
  if (chunk?.vector) {
    chunk.vector = toFloat32Array(chunk.vector);
  }
}

export class EmbeddingsCache {
  constructor(config) {
    this.config = config;
    this.vectorStore = [];
    this.fileHashes = new Map();
    this.isSaving = false;
    this.saveQueue = Promise.resolve();
    this.cacheMeta = {
      version: CACHE_META_VERSION,
      embeddingModel: config.embeddingModel,
    };
    this.annIndex = null;
    this.annMeta = null;
    this.annDirty = false;
    this.annLoading = null;
    this.annVectorCache = null;
    // Call graph data
    this.fileCallData = new Map(); // file -> { definitions: [], calls: [] }
    this.callGraph = null; // { defines, calledBy, fileCalls }
  }

  async load() {
    if (!this.config.enableCache) return;

    try {
      await fs.mkdir(this.config.cacheDirectory, { recursive: true });
      const cacheFile = path.join(this.config.cacheDirectory, 'embeddings.json');
      const hashFile = path.join(this.config.cacheDirectory, 'file-hashes.json');
      const metaFile = path.join(this.config.cacheDirectory, CACHE_META_FILE);

      const [metaData, cacheData, hashData] = await Promise.all([
        fs.readFile(metaFile, 'utf-8').catch(() => null),
        readJsonFile(cacheFile),
        readJsonFile(hashFile),
      ]);

      if (!metaData && !cacheData && !hashData) {
        return;
      }

      if (!metaData) {
        console.warn('[Cache] Missing cache metadata, ignoring cache');
        console.error('[Cache] Missing cache metadata, ignoring cache');
        return;
      }

      let meta = null;
      try {
        meta = JSON.parse(metaData);
      } catch {
        console.warn('[Cache] Invalid cache metadata, ignoring cache');
        console.error('[Cache] Invalid cache metadata, ignoring cache');
        return;
      }

      if (meta?.version !== CACHE_META_VERSION) {
        console.warn(`[Cache] Cache version mismatch (${meta?.version}), ignoring cache`);
        console.error(`[Cache] Cache version mismatch (${meta?.version}), ignoring cache`);
        return;
      }

      if (meta?.embeddingModel !== this.config.embeddingModel) {
        console.warn(
          `[Cache] Embedding model changed, ignoring cache (${meta?.embeddingModel} -> ${this.config.embeddingModel})`
        );
        console.error(
          `[Cache] Embedding model changed, ignoring cache (${meta?.embeddingModel} -> ${this.config.embeddingModel})`
        );
        return;
      }

      this.cacheMeta = meta;

      if (cacheData && hashData) {
        const rawVectorStore = cacheData;
        const rawHashes = new Map(Object.entries(hashData));

        // Filter cache to only include files matching current extensions
        const allowedExtensions = this.config.fileExtensions.map((ext) => `.${ext}`);

        this.vectorStore = rawVectorStore.filter((chunk) => {
          const ext = path.extname(chunk.file);
          return allowedExtensions.includes(ext);
        });
        for (const chunk of this.vectorStore) {
          normalizeChunkVector(chunk);
        }

        // Only keep hashes for files matching current extensions
        for (const [file, hash] of rawHashes) {
          const ext = path.extname(file);
          if (allowedExtensions.includes(ext)) {
            this.fileHashes.set(file, hash);
          }
        }

        const filtered = rawVectorStore.length - this.vectorStore.length;
        if (filtered > 0) {
          console.log(`[Cache] Filtered ${filtered} outdated cache entries`);
        }
        console.log(`[Cache] Loaded ${this.vectorStore.length} cached embeddings`);
        this.annDirty = false;
        this.annIndex = null;
        this.annMeta = null;
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
        // Call-graph file doesn't exist yet, that's OK
      }
    } catch (error) {
      console.warn('[Cache] Failed to load cache:', error.message);
      console.error('[Cache] Failed to load cache:', error.message);
    }
  }

  async save() {
    if (!this.config.enableCache) return;
    this.saveQueue = this.saveQueue.then(() => this.performSave());
    return this.saveQueue;
  }

  async performSave() {
    this.isSaving = true;

    try {
      await fs.mkdir(this.config.cacheDirectory, { recursive: true });
      const cacheFile = path.join(this.config.cacheDirectory, 'embeddings.json');
      const hashFile = path.join(this.config.cacheDirectory, 'file-hashes.json');
      const metaFile = path.join(this.config.cacheDirectory, CACHE_META_FILE);

      // Include indexing stats in meta for verification
      const uniqueFiles = new Set(this.vectorStore.map((chunk) => chunk.file));
      this.cacheMeta = {
        version: CACHE_META_VERSION,
        embeddingModel: this.config.embeddingModel,
        lastSaveTime: new Date().toISOString(),
        filesIndexed: uniqueFiles.size,
        chunksStored: this.vectorStore.length,
        workspace: this.config.searchDirectory || null,
      };

      // Use streaming writer for vector store to avoid huge string allocation
      const vectorWriter = new StreamingJsonWriter(cacheFile);
      try {
        await vectorWriter.writeStart();
        for (const item of this.vectorStore) {
          vectorWriter.writeItem(item);
        }
        await vectorWriter.writeEnd();
      } catch (err) {
        throw new Error(`Failed to stream cache: ${err.message}`);
      }

      await Promise.all([
        fs.writeFile(hashFile, JSON.stringify(Object.fromEntries(this.fileHashes), null, 2)),
        fs.writeFile(metaFile, JSON.stringify(this.cacheMeta, null, 2)),
      ]);

      // Save call-graph data (or remove stale cache if empty)
      const callGraphFile = path.join(this.config.cacheDirectory, CALL_GRAPH_FILE);
      if (this.fileCallData.size > 0) {
        await fs.writeFile(
          callGraphFile,
          JSON.stringify(Object.fromEntries(this.fileCallData), null, 2),
        );
      } else {
        await fs.rm(callGraphFile, { force: true });
      }
    } catch (error) {
      console.warn('[Cache] Failed to save cache:', error.message);
      console.error('[Cache] Failed to save cache:', error.message);
    } finally {
      this.isSaving = false;
    }
  }

  getVectorStore() {
    return this.vectorStore;
  }

  setVectorStore(store) {
    this.vectorStore = store;
    if (Array.isArray(this.vectorStore)) {
      for (const chunk of this.vectorStore) {
        normalizeChunkVector(chunk);
      }
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
    this.vectorStore = this.vectorStore.filter((chunk) => chunk.file !== file);
    this.invalidateAnnIndex();
    // Also clear call-graph data for this file
    this.removeFileCallData(file);
  }

  addToStore(chunk) {
    normalizeChunkVector(chunk);
    this.vectorStore.push(chunk);
    this.invalidateAnnIndex();
  }

  invalidateAnnIndex() {
    this.annIndex = null;
    this.annMeta = null;
    this.annDirty = true;
    this.annVectorCache = null;
  }

  getAnnVector(index) {
    if (!this.annVectorCache || this.annVectorCache.length !== this.vectorStore.length) {
      this.annVectorCache = new Array(this.vectorStore.length);
    }

    let cached = this.annVectorCache[index];
    if (!cached) {
      const vector = this.vectorStore[index]?.vector;
      if (!vector) {
        return null;
      }
      cached = toFloat32Array(vector);
      this.annVectorCache[index] = cached;
    }

    return cached;
  }

  getAnnIndexPaths() {
    return {
      indexFile: path.join(this.config.cacheDirectory, ANN_INDEX_FILE),
      metaFile: path.join(this.config.cacheDirectory, ANN_META_FILE),
    };
  }

  async ensureAnnIndex() {
    if (!this.config.annEnabled) return null;
    if (this.vectorStore.length < this.config.annMinChunks) return null;
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

    if (!metaData) {
      return false;
    }

    let meta = null;
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
      console.warn(`[ANN] Embedding model changed for ANN index, rebuilding`);
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

    const index = new HierarchicalNSW(meta.metric, dim);
    const loaded = readHnswIndex(index, indexFile, meta.count);
    if (!loaded) {
      console.warn('[ANN] Failed to load ANN index file, rebuilding');
      return false;
    }

    if (typeof index.setEf === 'function') {
      index.setEf(this.config.annEfSearch);
    }

    this.annIndex = index;
    this.annMeta = meta;
    this.annDirty = false;
    console.log(`[ANN] Loaded ANN index (${meta.count} vectors)`);
    return true;
  }

  async buildAnnIndex(HierarchicalNSW, dim) {
    const total = this.vectorStore.length;
    if (total === 0) return null;

    try {
      const index = new HierarchicalNSW(this.config.annMetric, dim);
      initHnswIndex(index, total, this.config.annM, this.config.annEfConstruction);

      for (let i = 0; i < total; i++) {
        const vector = this.getAnnVector(i);
        if (!vector) {
          throw new Error(`Missing vector for ANN index at position ${i}`);
        }
        index.addPoint(vector, i);
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
        m: this.config.annM,
        efConstruction: this.config.annEfConstruction,
        efSearch: this.config.annEfSearch,
      };
      this.annDirty = false;

      if (this.config.annIndexCache !== false) {
        try {
          await fs.mkdir(this.config.cacheDirectory, { recursive: true });
          const { indexFile, metaFile } = this.getAnnIndexPaths();
          index.writeIndexSync(indexFile);
          await fs.writeFile(metaFile, JSON.stringify(this.annMeta, null, 2));
          console.log(`[ANN] Saved ANN index (${total} vectors)`);
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
      return null;
    }
  }

  async queryAnn(queryVector, k) {
    const index = await this.ensureAnnIndex();
    if (!index) return null;

    const results = index.searchKnn(toFloat32Array(queryVector), k);
    const labels = normalizeLabels(results);

    if (labels.length === 0) return null;
    const filtered = labels.filter(
      (label) => Number.isInteger(label) && label >= 0 && label < this.vectorStore.length
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
      console.log(`[Cache] Cache cleared successfully: ${this.config.cacheDirectory}`);
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
      console.log(`[ANN] efSearch updated to ${efSearch} (applied to active index)`);
      return { success: true, applied: true, efSearch };
    } else {
      console.log(`[ANN] efSearch updated to ${efSearch} (will apply on next index build)`);
      return { success: true, applied: false, efSearch };
    }
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

  // ========== Call Graph Methods ==========

  /**
   * Clear all call-graph data (optionally remove persisted cache file)
   */
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
          console.error(`[Cache] Failed to remove call-graph cache: ${error.message}`);
        }
      }
    }
  }

  /**
   * Remove call-graph entries for files no longer in the codebase
   */
  pruneCallGraphData(validFiles) {
    if (!validFiles || this.fileCallData.size === 0) return 0;

    let pruned = 0;
    for (const file of Array.from(this.fileCallData.keys())) {
      if (!validFiles.has(file)) {
        this.fileCallData.delete(file);
        pruned++;
      }
    }

    if (pruned > 0) {
      this.callGraph = null;
    }

    return pruned;
  }

  /**
   * Store call data for a file
   */
  setFileCallData(file, data) {
    this.fileCallData.set(file, data);
    this.callGraph = null; // Invalidate cached graph
  }

  /**
   * Get call data for a file
   */
  getFileCallData(file) {
    return this.fileCallData.get(file);
  }

  /**
   * Remove call data for a file
   */
  removeFileCallData(file) {
    this.fileCallData.delete(file);
    this.callGraph = null; // Invalidate cached graph
  }

  /**
   * Rebuild the call graph from file data
   */
  rebuildCallGraph() {
    // Lazy import to avoid circular dependencies
    import('./call-graph.js')
      .then(({ buildCallGraph }) => {
        this.callGraph = buildCallGraph(this.fileCallData);
        if (this.config.verbose) {
          console.log(
            `[CallGraph] Built graph: ${this.callGraph.defines.size} definitions, ${this.callGraph.calledBy.size} call targets`
          );
          console.error(
            `[CallGraph] Built graph: ${this.callGraph.defines.size} definitions, ${this.callGraph.calledBy.size} call targets`
          );
        }
      })
      .catch((err) => {
        console.error(`[CallGraph] Failed to build: ${err.message}`);
        this.callGraph = null;
      });
  }

  /**
   * Get files related to symbols via call graph
   */
  async getRelatedFiles(symbols) {
    if (!this.config.callGraphEnabled || symbols.length === 0) {
      return new Map();
    }

    // Rebuild graph if needed
    if (!this.callGraph && this.fileCallData.size > 0) {
      const { buildCallGraph } = await import('./call-graph.js');
      this.callGraph = buildCallGraph(this.fileCallData);
    }

    if (!this.callGraph) {
      return new Map();
    }

    const { getRelatedFiles } = await import('./call-graph.js');
    return getRelatedFiles(this.callGraph, symbols, this.config.callGraphMaxHops);
  }

  /**
   * Get call graph statistics
   */
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
