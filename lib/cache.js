import fs from 'fs/promises';
import path from 'path';
import { Worker } from 'worker_threads';
import { StreamingJsonWriter } from './json-writer.js';
import {
  BinaryVectorStore,
  BinaryStoreCorruptionError,
  recordBinaryStoreCorruption,
} from './vector-store-binary.js';
import { SqliteVectorStore } from './vector-store-sqlite.js';
import { isNonProjectDirectory } from './config.js';
import {
  JSON_WORKER_THRESHOLD_BYTES,
  ANN_DIMENSION_SAMPLE_SIZE,
  HNSWLIB_ERROR_RESET_MS,
  DEFAULT_READER_WAIT_TIMEOUT_MS,
} from './constants.js';

const CACHE_META_VERSION = 1;
const CACHE_META_FILE = 'meta.json';


const ANN_META_VERSION = 1;
const ANN_INDEX_FILE = 'ann-index.bin';
const ANN_META_FILE = 'ann-meta.json';

const CALL_GRAPH_FILE = 'call-graph.json';

const IS_TEST_ENV = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';


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
        return;
      }
      if (!settled) {
        const err = new Error('JSON worker exited without sending a response');
        console.error(`[Cache] ${err.message}`);
        finish(reject, err);
      }
    });
  });
}

async function readJsonFile(
  filePath,
  { workerThresholdBytes = JSON_WORKER_THRESHOLD_BYTES } = {}
) {
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
  
  if (hnswlibLoadError) {
    if (hnswlibLoadError._timestamp && Date.now() - hnswlibLoadError._timestamp > HNSWLIB_ERROR_RESET_MS) {
      hnswlibLoadError = null;
      hnswlibPromise = null;
    } else {
      return null;
    }
  }

  if (!hnswlibPromise) {
    hnswlibPromise = import('hnswlib-node')
      .then((mod) => {
        const HierarchicalNSW = mod?.HierarchicalNSW || mod?.default?.HierarchicalNSW;
        if (!HierarchicalNSW) throw new Error('HierarchicalNSW export not found');
        return HierarchicalNSW;
      })
      .catch((err) => {
        
        err._timestamp = Date.now();
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
  } catch (err) {
    console.warn(`[ANN] Standard init failed: ${err.message}`);
  }
  try {
    index.initIndex(maxElements, m, efConstruction);
    return;
  } catch (err) {
    console.warn(`[ANN] Legacy init failed: ${err.message}`);
  }
  index.initIndex(maxElements);
}

function readHnswIndex(index, filePath, maxElements) {
  try {
    index.readIndexSync(filePath, maxElements);
    return true;
  } catch {
    
  }
  try {
    index.readIndexSync(filePath);
    return true;
  } catch (err) {
    console.warn(`[ANN] Read index failed: ${err.message}`);
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

  
  let result;
  if (ArrayBuffer.isView(vector)) {
    result = Float32Array.from(vector);
  } else {
    result = new Float32Array(vector);
  }

  
  if (IS_TEST_ENV && result.length > 0) {
    for (let i = 0; i < result.length; i++) {
      if (!Number.isFinite(result[i])) {
        throw new Error(
          `Invalid vector value at index ${i}: ${result[i]}. ` +
            'Vector contains NaN or Infinity, which will corrupt search results.'
        );
      }
    }
  }

  return result;
}

function normalizeChunkVector(chunk) {
  if (chunk?.vector) chunk.vector = ensureFloat32(chunk.vector);
}

function assignChunkIndices(store) {
  if (!Array.isArray(store)) return;
  for (let i = 0; i < store.length; i += 1) {
    const chunk = store[i];
    if (chunk) {
      chunk._index = i;
    }
  }
}

function normalizeFileHashEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return { hash: entry };
  if (typeof entry !== 'object') return null;
  if (typeof entry.hash !== 'string') return null;
  const normalized = { hash: entry.hash };
  if (Number.isFinite(entry.mtimeMs)) normalized.mtimeMs = entry.mtimeMs;
  if (Number.isFinite(entry.size)) normalized.size = entry.size;
  return normalized;
}

function serializeFileHashEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return { hash: entry };
  if (typeof entry !== 'object') return null;
  if (typeof entry.hash !== 'string') return null;
  const serialized = { hash: entry.hash };
  if (Number.isFinite(entry.mtimeMs)) serialized.mtimeMs = entry.mtimeMs;
  if (Number.isFinite(entry.size)) serialized.size = entry.size;
  return serialized;
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
    this.lastIndexDurationMs = null;
    this.lastIndexStats = null;

    this.cacheMeta = {
      version: CACHE_META_VERSION,
      embeddingModel: config.embeddingModel,
      embeddingDimension: config.embeddingDimension ?? null,
    };

    
    this.saveQueue = Promise.resolve();
    this._saveTimer = null;
    this._saveRequested = false;
    this._savePromise = null;
    this._saveThrowOnError = false;
    this.lastSaveError = null;

    
    this.annIndex = null;
    this.annMeta = null;
    this.annDirty = false; 
    this.annPersistDirty = false; 
    this.annLoading = null;
    this.annVectorCache = null;

    
    this.fileCallData = new Map();
    this.callGraph = null;
    this._callGraphBuild = null;

    
    this.binaryStore = null;

    
    this.sqliteStore = null;

    
    this.initErrors = [];

    
    this.activeReads = 0;
    this._readWaiters = [];
    this._saveInProgress = false; 

    
    this._clearedAfterIndex = false;
    this._loadPromise = null;
    this._corruptionDetected = false;
  }

  /**
   * Returns true if the last load() detected binary store corruption.
   * Used by the server to decide whether to trigger an automatic re-index.
   */
  shouldAutoReindex() {
    return this._corruptionDetected === true;
  }

  consumeAutoReindex() {
    const should = this._corruptionDetected === true;
    this._corruptionDetected = false;
    return should;
  }

  
  addInitError(stage, error) {
    this.initErrors.push({
      stage,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
      timestamp: Date.now(),
    });
  }

  clearInMemoryState() {
    this.vectorStore = [];
    this.fileHashes.clear();
    this.invalidateAnnIndex();
    this.fileCallData.clear();
    this.callGraph = null;
    this.initErrors = [];
    if (this.binaryStore) {
      try {
        this.binaryStore.close?.();
      } catch {
        
      }
      this.binaryStore = null;
    }
    if (this.sqliteStore) {
      try {
        this.sqliteStore.close?.();
      } catch {
        
      }
      this.sqliteStore = null;
    }
  }

  async close() {
    if (this.binaryStore) {
      await this.binaryStore.close();
      this.binaryStore = null;
    }
    if (this.sqliteStore) {
      try {
        this.sqliteStore.close();
      } catch {
        
      }
      this.sqliteStore = null;
    }
  }

  async ensureLoaded({ preferDisk = false } = {}) {
    if (!this.config.enableCache) return;
    if (!this._clearedAfterIndex) return;
    if (this._loadPromise) return this._loadPromise;

    this._loadPromise = (async () => {
      if (preferDisk && this.config.verbose) {
        console.info('[Cache] ensureLoaded: forcing disk vector mode for incremental low-RAM reload');
      }
      await this.load({
        forceVectorLoadMode: preferDisk ? 'disk' : undefined,
      });
      this._clearedAfterIndex = false;
    })().finally(() => {
      this._loadPromise = null;
    });

    return this._loadPromise;
  }

  async dropInMemoryVectors() {
    if (!this.config.enableCache) return;

    if (this.activeReads > 0) {
      await this.waitForReaders();
    }

    this.vectorStore = [];
    this.annVectorCache = null;
    this.annIndex = null;
    this.annMeta = null;
    this.annDirty = true;
    this.annPersistDirty = false;

    if (this.binaryStore) {
      try {
        await this.binaryStore.close();
      } catch {
        
      }
      this.binaryStore = null;
    }

    if (this.sqliteStore) {
      try {
        this.sqliteStore.close();
      } catch {
        
      }
      this.sqliteStore = null;
    }

    this._clearedAfterIndex = true;
  }

  

  startRead() {
    
    if (this._saveInProgress) {
      throw new Error('Cache save in progress, try again shortly');
    }
    this.activeReads++;
  }

  endRead() {
    if (this.activeReads > 0) {
      this.activeReads--;
      if (this.activeReads === 0 && this._readWaiters.length > 0) {
        const waiters = this._readWaiters;
        this._readWaiters = [];
        for (const resolve of waiters) {
          resolve();
        }
      }
    }
  }

  async waitForReaders() {
    if (this.activeReads === 0) return;
    await new Promise((resolve) => {
      this._readWaiters.push(resolve);
    });
  }

  async waitForReadersWithTimeout(timeoutMs = 5000) {
    if (this.activeReads === 0) return true;
    let timedOut = false;
    let resolved = false;
    let waiterResolve;
    const waiterPromise = new Promise((resolve) => {
      waiterResolve = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
      this._readWaiters.push(waiterResolve);
    });
    await Promise.race([
      waiterPromise,
      new Promise((resolve) => {
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            timedOut = true;
            
            const idx = this._readWaiters.indexOf(waiterResolve);
            if (idx >= 0) this._readWaiters.splice(idx, 1);
            resolve();
          }
        }, timeoutMs);
      }),
    ]);
    if (timedOut) {
      
      console.warn(
        `[Cache] Timed out waiting for ${this.activeReads} active reader(s); proceeding with save anyway. ` +
          'This may cause data inconsistency if readers access the store during write.'
      );
    }
    return !timedOut;
  }

  

  
  async reset() {
    this.vectorStore = [];
    if (this.binaryStore) {
      try {
        await this.binaryStore.close();
      } catch {
        
      }
      this.binaryStore = null;
    }
    if (this.sqliteStore) {
      try {
        this.sqliteStore.close();
      } catch {
        
      }
      this.sqliteStore = null;
    }
    this.fileHashes.clear();
    this.invalidateAnnIndex();
    await this.clearCallGraphData({ removeFile: true });
    this.initErrors = [];
  }

  

  async load({ forceVectorLoadMode } = {}) {
    if (!this.config.enableCache) return;
    this._corruptionDetected = false;

    try {
      await fs.mkdir(this.config.cacheDirectory, { recursive: true });

      const cacheFile = path.join(this.config.cacheDirectory, 'embeddings.json');
      const hashFile = path.join(this.config.cacheDirectory, 'file-hashes.json');
      const metaFile = path.join(this.config.cacheDirectory, CACHE_META_FILE);

      const workerThresholdBytes =
        Number.isInteger(this.config.jsonWorkerThresholdBytes) &&
        this.config.jsonWorkerThresholdBytes > 0
          ? this.config.jsonWorkerThresholdBytes
          : JSON_WORKER_THRESHOLD_BYTES;

      const useBinary = this.config.vectorStoreFormat === 'binary';
      const useSqlite = this.config.vectorStoreFormat === 'sqlite';

      const { vectorsPath, recordsPath, contentPath, filesPath } = BinaryVectorStore.getPaths(
        this.config.cacheDirectory
      );
      const pathExists = async (targetPath) => {
        try {
          await fs.access(targetPath);
          return true;
        } catch {
          return false;
        }
      };

      
      let cacheData = null;
      let hashData = null;
      let prefetched = false;
      if (IS_TEST_ENV) {
        prefetched = true;
        const cachePromise = useBinary || useSqlite
          ? Promise.resolve(null)
          : readJsonFile(cacheFile, { workerThresholdBytes });
        [cacheData, hashData] = await Promise.all([
          cachePromise,
          readJsonFile(hashFile, { workerThresholdBytes }),
        ]);
      }

      
      const metaData = await fs.readFile(metaFile, 'utf-8').catch(() => null);
      if (!metaData) {
        console.warn('[Cache] Missing cache metadata, ignoring cache');
        this.clearInMemoryState();
        return;
      }

      let meta;
      try {
        meta = JSON.parse(metaData);
      } catch {
        console.warn('[Cache] Invalid cache metadata, ignoring cache');
        this.clearInMemoryState();
        return;
      }

      if (meta?.version !== CACHE_META_VERSION) {
        console.warn(`[Cache] Cache version mismatch (${meta?.version}), ignoring cache`);
        this.clearInMemoryState();
        return;
      }

      if (meta?.embeddingModel !== this.config.embeddingModel) {
        console.warn(
          `[Cache] Embedding model changed, ignoring cache (${meta?.embeddingModel} -> ${this.config.embeddingModel})`
        );
        this.clearInMemoryState();
        return;
      }
      const expectedDimension = this.config.embeddingDimension ?? null;
      const metaDimension = meta?.embeddingDimension ?? null;
      if (metaDimension !== expectedDimension) {
        console.warn(
          `[Cache] Embedding dimension changed, ignoring cache (${metaDimension} -> ${expectedDimension})`
        );
        this.clearInMemoryState();
        return;
      }

      if (!prefetched) {
        [cacheData, hashData] = await Promise.all([
          useBinary || useSqlite ? Promise.resolve(null) : readJsonFile(cacheFile, { workerThresholdBytes }),
          readJsonFile(hashFile, { workerThresholdBytes }),
        ]);
      }

      this.cacheMeta = meta;

      const [binaryFilesPresent, jsonCachePresent] = await Promise.all([
        (async () => {
          const [vectorsOk, recordsOk, contentOk, filesOk] = await Promise.all([
            pathExists(vectorsPath),
            pathExists(recordsPath),
            pathExists(contentPath),
            pathExists(filesPath),
          ]);
          return vectorsOk && recordsOk && contentOk && filesOk;
        })(),
        pathExists(cacheFile),
      ]);

      if (useBinary && !binaryFilesPresent) {
        if (jsonCachePresent) {
          console.warn(
            '[Cache] vectorStoreFormat=binary but binary cache files are missing; embeddings.json exists. If you switched formats, reindex or set vectorStoreFormat=json.'
          );
        } else {
          console.warn(
            '[Cache] vectorStoreFormat=binary but binary cache files are missing. Reindex to regenerate the cache.'
          );
        }
      } else if (!useBinary && !useSqlite && !jsonCachePresent) {
        if (binaryFilesPresent) {
          console.warn(
            '[Cache] vectorStoreFormat=json but binary cache files exist. If you switched formats, set vectorStoreFormat=binary or reindex.'
          );
        } else {
          console.warn(
            '[Cache] vectorStoreFormat=json but embeddings.json is missing. Reindex to regenerate the cache.'
          );
        }
      }

      const configuredVectorLoadMode =
        typeof this.config.vectorStoreLoadMode === 'string'
          ? this.config.vectorStoreLoadMode.toLowerCase()
          : 'memory';
      const effectiveVectorLoadMode =
        forceVectorLoadMode === 'disk' || forceVectorLoadMode === 'memory'
          ? forceVectorLoadMode
          : configuredVectorLoadMode;

      if (useBinary) {
        try {
          this.binaryStore = await BinaryVectorStore.load(this.config.cacheDirectory, {
            contentCacheEntries: this.config.contentCacheEntries,
            vectorCacheEntries: this.config.vectorCacheEntries,
            vectorLoadMode: effectiveVectorLoadMode,
          });
          cacheData = await this.binaryStore.toChunkViews({
            includeContent: this.config.vectorStoreContentMode === 'inline',
            includeVector: effectiveVectorLoadMode !== 'disk',
          });
        } catch (err) {
          this.binaryStore = null;
          const isCorruption = err instanceof BinaryStoreCorruptionError ||
            err?.name === 'BinaryStoreCorruptionError';
          if (isCorruption) {
            console.warn(`[Cache] Binary store corruption detected: ${err.message}`);
            this._corruptionDetected = true;
            await recordBinaryStoreCorruption(this.config.cacheDirectory, {
              message: err.message,
              context: 'cache.load binary store',
              action: 'detected',
            });
          } else {
            console.warn(`[Cache] Failed to load binary vector store: ${err.message}`);
          }
        }
      }

      
      if (useSqlite) {
        try {
          this.sqliteStore = await SqliteVectorStore.load(this.config.cacheDirectory);
          if (this.sqliteStore) {
            cacheData = this.sqliteStore.toChunkViews({
              includeContent: this.config.vectorStoreContentMode === 'inline',
              includeVector: effectiveVectorLoadMode !== 'disk',
            });
          } else {
            
            console.warn('[Cache] vectorStoreFormat=sqlite but vectors.sqlite is missing. Reindex to regenerate the cache.');
          }
        } catch (err) {
          this.sqliteStore = null;
          console.warn(`[Cache] Failed to load SQLite vector store: ${err.message}`);
        }
      }

      if (!cacheData) {
        cacheData = await readJsonFile(cacheFile, { workerThresholdBytes });
      }

      const hasCacheData = Array.isArray(cacheData);
      const hasHashData = hashData && typeof hashData === 'object';

      if (hasCacheData) {
        const allowedExtensions = new Set(
          (this.config.fileExtensions || []).map((ext) => `.${ext}`)
        );
        const allowedFileNames = new Set(this.config.fileNames || []);
        const applyExtensionFilter = !this.binaryStore;
        const shouldKeepFile = (filePath) => {
          const ext = path.extname(filePath);
          if (allowedExtensions.has(ext)) return true;
          return allowedFileNames.has(path.basename(filePath));
        };

        const rawHashes = hasHashData ? new Map(Object.entries(hashData)) : new Map();
        this.vectorStore = [];
        this.fileHashes.clear();

        
        for (const chunk of cacheData) {
          if (applyExtensionFilter) {
            if (!shouldKeepFile(chunk.file)) continue;
          }
          normalizeChunkVector(chunk);
          this.vectorStore.push(chunk);
        }
        const filteredCount = cacheData.length - this.vectorStore.length;
        if (filteredCount > 0 && this.config.verbose) {
          console.info(`[Cache] Filtered ${filteredCount} outdated cache entries`);
        }

        if (hasHashData) {
          
          for (const [file, entry] of rawHashes) {
            if (!applyExtensionFilter || shouldKeepFile(file)) {
              const normalized = normalizeFileHashEntry(entry);
              if (normalized) {
                this.fileHashes.set(file, normalized);
              }
            }
          }
        } else {
          console.warn(
            '[Cache] Missing file-hashes.json; loaded embeddings but hashes were cleared'
          );
        }

        assignChunkIndices(this.vectorStore);

        if (this.config.verbose) {
          console.info(`[Cache] Loaded ${this.vectorStore.length} cached embeddings`);
        }

        
        this.annDirty = false;
        this.annPersistDirty = false;
        this.annIndex = null;
        this.annMeta = null;
        this.annVectorCache = null;
      } else if (cacheData) {
        console.warn('[Cache] Cache data is not an array; ignoring cached embeddings');
      } else if (hasHashData) {
        console.warn('[Cache] Hashes exist without embeddings; ignoring file-hashes.json');
      }

      
      const callGraphFile = path.join(this.config.cacheDirectory, CALL_GRAPH_FILE);
      try {
        const callGraphData = await fs.readFile(callGraphFile, 'utf8');
        const parsed = JSON.parse(callGraphData);
        this.fileCallData = new Map(Object.entries(parsed));
        if (this.config.verbose) {
          console.info(`[Cache] Loaded call-graph data for ${this.fileCallData.size} files`);
        }
      } catch {
        
      }
    } catch (error) {
      console.warn('[Cache] Failed to load cache:', error.message);
      this.clearInMemoryState();
    }
  }

  

  save({ throwOnError = false } = {}) {
    if (!this.config.enableCache) return Promise.resolve();

    this._saveRequested = true;
    if (throwOnError) {
      this._saveThrowOnError = true;
    }

    if (this._saveTimer) return this._savePromise ?? Promise.resolve();

    const debounceMs = Number.isInteger(this.config.saveDebounceMs)
      ? this.config.saveDebounceMs
      : 250;

    this._savePromise = new Promise((resolve, reject) => {
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        const rejectOnSaveError = this._saveThrowOnError;
        this._saveThrowOnError = false;

        this.saveQueue = this.saveQueue
          .catch(() => {
            
          })
          .then(async () => {
            while (this._saveRequested) {
              this._saveRequested = false;
              await this.performSave({ throwOnError: rejectOnSaveError });
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

  async performSave({ throwOnError = false } = {}) {
    
    this._saveInProgress = true;
    if (
      this.config.allowSystemWorkspaceCache !== true &&
      this.config.searchDirectory &&
      isNonProjectDirectory(this.config.searchDirectory)
    ) {
      const source = this.config.workspaceResolution?.source || 'unknown';
      console.warn(
        `[Cache] Skipping cache save for non-project workspace (${source}): ${this.config.searchDirectory}`
      );
      this._saveInProgress = false;
      return;
    }

    
    if (this.activeReads > 0) {
      const timeoutMs = this.config.saveReaderWaitTimeoutMs ?? DEFAULT_READER_WAIT_TIMEOUT_MS;
      const allReadersFinished = await this.waitForReadersWithTimeout(timeoutMs);
      if (!allReadersFinished && !this.config.forceSaveWithActiveReaders) {
        console.warn('[Cache] Aborting save - active readers still present after timeout');
        this._saveInProgress = false; 
        return; 
      }
    }

    this.isSaving = true;

    try {
      await fs.mkdir(this.config.cacheDirectory, { recursive: true });

      const cacheFile = path.join(this.config.cacheDirectory, 'embeddings.json');
      const hashFile = path.join(this.config.cacheDirectory, 'file-hashes.json');
      const metaFile = path.join(this.config.cacheDirectory, CACHE_META_FILE);

      
      
      const snapshotStore = Array.isArray(this.vectorStore) ? [...this.vectorStore] : [];
      const supportsBackendVectorResolve =
        this.config.vectorStoreFormat === 'binary' || this.config.vectorStoreFormat === 'sqlite';
      const hasMissingVectors = snapshotStore.some(
        (chunk) => chunk && (chunk.vector === undefined || chunk.vector === null)
      );
      const useDiskVectors =
        supportsBackendVectorResolve &&
        (this.config.vectorStoreLoadMode === 'disk' || hasMissingVectors);
      if (hasMissingVectors && !useDiskVectors) {
        throw new Error(
          'Missing vector data for cache write and backend vector resolution is unavailable'
        );
      }

      this.cacheMeta = {
        version: CACHE_META_VERSION,
        embeddingModel: this.config.embeddingModel,
        embeddingDimension: this.config.embeddingDimension ?? null,
        lastSaveTime: new Date().toISOString(),
        filesIndexed: this.fileHashes.size,
        chunksStored: snapshotStore.length,
        workspace: this.config.searchDirectory || null,
      };
      if (Number.isFinite(this.lastIndexDurationMs) && this.lastIndexDurationMs >= 0) {
        this.cacheMeta.indexDurationMs = Math.round(this.lastIndexDurationMs);
      }
      if (this.lastIndexStats && typeof this.lastIndexStats === 'object') {
        Object.assign(this.cacheMeta, this.lastIndexStats);
      }

      const total = snapshotStore.length;
      if (this.config.vectorStoreFormat === 'binary') {
        this.binaryStore = await BinaryVectorStore.write(
          this.config.cacheDirectory,
          snapshotStore,
          {
            contentCacheEntries: this.config.contentCacheEntries,
            vectorCacheEntries: this.config.vectorCacheEntries,
            vectorLoadMode: useDiskVectors ? 'disk' : this.config.vectorStoreLoadMode,
            getContent: (chunk, index) => this.getChunkContent(chunk, index),
            getVector: useDiskVectors ? (chunk, index) => this.getChunkVector(chunk, index) : null,
            preRename: async () => {
              if (this.activeReads > 0) {
                await this.waitForReadersWithTimeout(
                  Number.isInteger(this.config.saveReaderWaitTimeoutMs)
                    ? this.config.saveReaderWaitTimeoutMs
                    : 5000
                );
              }
              if (this.binaryStore) {
                await this.binaryStore.close();
                this.binaryStore = null;
              }
            },
          }
        );
        if (this.binaryStore) {
          this.cacheMeta.chunksStored = this.binaryStore.length;
        }
      } else if (this.config.vectorStoreFormat === 'sqlite') {
        
        if (this.sqliteStore) {
          try {
            this.sqliteStore.close();
          } catch {
            
          }
          this.sqliteStore = null;
        }
        this.sqliteStore = await SqliteVectorStore.write(
          this.config.cacheDirectory,
          snapshotStore,
          {
            getContent: (chunk, index) => this.getChunkContent(chunk, index),
            getVector: useDiskVectors ? (chunk, index) => this.getChunkVector(chunk, index) : null,
            preRename: async () => {
              if (this.activeReads > 0) {
                await this.waitForReadersWithTimeout(
                  Number.isInteger(this.config.saveReaderWaitTimeoutMs)
                    ? this.config.saveReaderWaitTimeoutMs
                    : 5000
                );
              }
            },
          }
        );
        if (this.sqliteStore) {
          this.cacheMeta.chunksStored = this.sqliteStore.length();
        }
      } else {
        const vectorWriter = new StreamingJsonWriter(cacheFile, {
          highWaterMark: this.config.cacheWriteHighWaterMark ?? 256 * 1024,
          floatDigits: this.config.cacheVectorFloatDigits ?? 6,
          flushChars: this.config.cacheVectorFlushChars ?? 256 * 1024,
          indent: '', 
          assumeFinite: this.config.cacheVectorAssumeFinite,
          checkFinite: this.config.cacheVectorCheckFinite,
          noMutation: this.config.cacheVectorNoMutation ?? false,
          joinThreshold: this.config.cacheVectorJoinThreshold ?? 8192,
          joinChunkSize: this.config.cacheVectorJoinChunkSize ?? 2048,
        });

        await vectorWriter.writeStart();

        
        const yieldEvery = total >= 50_000 ? 5000 : 0;

        try {
          for (let i = 0; i < total; i++) {
            const pending = vectorWriter.writeItem(snapshotStore[i]);
            if (pending) await pending;
            if (yieldEvery && i > 0 && i % yieldEvery === 0) await yieldToLoop();
          }
          await vectorWriter.writeEnd();
        } catch (e) {
          vectorWriter.abort(e);
          throw e;
        }
      }

      const hashEntries = {};
      for (const [file, entry] of this.fileHashes) {
        const serialized = serializeFileHashEntry(entry);
        if (serialized) {
          hashEntries[file] = serialized;
        }
      }

      await Promise.all([
        fs.writeFile(hashFile, JSON.stringify(hashEntries, null, 2)),
        fs.writeFile(metaFile, JSON.stringify(this.cacheMeta, null, 2)),
      ]);

      
      const callGraphFile = path.join(this.config.cacheDirectory, CALL_GRAPH_FILE);
      if (this.fileCallData.size > 0) {
        await fs.writeFile(
          callGraphFile,
          JSON.stringify(Object.fromEntries(this.fileCallData), null, 2)
        );
      } else {
        await fs.rm(callGraphFile, { force: true });
      }

      
      
      if (
        this.config.annIndexCache !== false &&
        this.annPersistDirty &&
        !this.annDirty &&
        !this._annWriting &&
        this.annIndex &&
        this.annMeta
      ) {
        this._annWriting = true;
        try {
          const { indexFile, metaFile: annMetaFile } = this.getAnnIndexPaths();
          this.annIndex.writeIndexSync(indexFile);
          await fs.writeFile(annMetaFile, JSON.stringify(this.annMeta, null, 2));
          this.annPersistDirty = false;
          if (this.config.verbose) {
            console.info(`[ANN] Persisted updated ANN index (${this.annMeta.count} vectors)`);
          }
        } catch (error) {
          console.warn(`[ANN] Failed to persist ANN index: ${error.message}`);
        } finally {
          this._annWriting = false;
        }
      }
      this.lastSaveError = null;
    } catch (error) {
      this.lastSaveError = error instanceof Error ? error : new Error(String(error));
      console.warn('[Cache] Failed to save cache:', this.lastSaveError.message);
      
      if (
        this.config.vectorStoreFormat === 'binary' &&
        this.binaryStore &&
        !this.binaryStore.vectorsBuffer
      ) {
        try {
          console.info('[Cache] Attempting to recover binary store after failed save...');
          this.binaryStore = await BinaryVectorStore.load(this.config.cacheDirectory, {
            contentCacheEntries: this.config.contentCacheEntries,
          });
          console.info('[Cache] Binary store recovered.');
        } catch (recoverErr) {
          console.warn(`[Cache] Failed to recover binary store: ${recoverErr.message}`);
          this.binaryStore = null; 
        }
      }
      
      if (
        this.config.vectorStoreFormat === 'sqlite' &&
        !this.sqliteStore
      ) {
        try {
          console.info('[Cache] Attempting to recover SQLite store after failed save...');
          this.sqliteStore = await SqliteVectorStore.load(this.config.cacheDirectory);
          if (this.sqliteStore) {
            console.info('[Cache] SQLite store recovered.');
          }
        } catch (recoverErr) {
          console.warn(`[Cache] Failed to recover SQLite store: ${recoverErr.message}`);
          this.sqliteStore = null;
        }
      }
      if (throwOnError) {
        const wrapped = new Error(`Cache save failed: ${this.lastSaveError.message}`);
        wrapped.cause = this.lastSaveError;
        throw wrapped;
      }
    } finally {
      this.isSaving = false;
      this._saveInProgress = false; 
    }
  }

  

  getVectorStore() {
    return Array.isArray(this.vectorStore) ? this.vectorStore : [];
  }

  async setVectorStore(store) {
    const previousBinaryStore = this.binaryStore;
    const previousSqliteStore = this.sqliteStore;
    this.vectorStore = store;
    this.binaryStore = null;
    this.sqliteStore = null;
    if (Array.isArray(this.vectorStore)) {
      for (const chunk of this.vectorStore) normalizeChunkVector(chunk);
      assignChunkIndices(this.vectorStore);
    }
    this.invalidateAnnIndex();
    if (previousBinaryStore) {
      try {
        await previousBinaryStore.close();
      } catch {
        
      }
    }
    if (previousSqliteStore) {
      try {
        previousSqliteStore.close();
      } catch {
        
      }
    }
  }

  setLastIndexDuration(durationMs) {
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      this.lastIndexDurationMs = durationMs;
    }
  }

  setLastIndexStats(stats) {
    if (stats && typeof stats === 'object') {
      this.lastIndexStats = { ...stats };
    }
  }

  getFileHash(file) {
    const entry = this.fileHashes.get(file);
    if (typeof entry === 'string') return entry;
    return entry?.hash;
  }

  getFileHashKeys() {
    return Array.from(this.fileHashes.keys());
  }

  getFileHashCount() {
    return this.fileHashes.size;
  }

  clearFileHashes() {
    this.fileHashes.clear();
  }

  setFileHashes(entries) {
    this.fileHashes.clear();
    if (!entries || typeof entries !== 'object') return;
    const iterator =
      entries instanceof Map
        ? entries.entries()
        : Object.entries(entries);
    if (!iterator) return;
    for (const [file, entry] of iterator) {
      const normalized = normalizeFileHashEntry(entry);
      if (normalized) {
        this.fileHashes.set(file, normalized);
      }
    }
  }

  setFileHash(file, hash, meta = null) {
    const entry = { hash };
    if (meta && typeof meta === 'object') {
      if (Number.isFinite(meta.mtimeMs)) entry.mtimeMs = meta.mtimeMs;
      if (Number.isFinite(meta.size)) entry.size = meta.size;
    }
    this.fileHashes.set(file, entry);
  }

  getFileMeta(file) {
    const entry = this.fileHashes.get(file);
    if (!entry) return null;
    if (typeof entry === 'string') return { hash: entry };
    return entry;
  }

  getChunkVector(chunk, index = null) {
    if (typeof chunk === 'number') {
      const store = Array.isArray(this.vectorStore) ? this.vectorStore : null;
      const entry = store ? store[chunk] : null;
      if (entry?.vector) return entry.vector;
      if (this.binaryStore) {
        const resolved = Number.isInteger(entry?._binaryIndex) ? entry._binaryIndex : chunk;
        return this.binaryStore.getVector(resolved);
      }
      if (this.sqliteStore) {
        const resolved = Number.isInteger(entry?._sqliteIndex) ? entry._sqliteIndex : chunk;
        return this.sqliteStore.getVector(resolved);
      }
      return null;
    }

    if (chunk?.vector) return chunk.vector;
    const resolved = Number.isInteger(index) ? index : chunk?._index;
    if (this.binaryStore && Number.isInteger(chunk?._binaryIndex)) {
      return this.binaryStore.getVector(chunk._binaryIndex);
    }
    if (this.binaryStore && !Array.isArray(this.vectorStore) && Number.isInteger(resolved)) {
      return this.binaryStore.getVector(resolved);
    }
    if (this.sqliteStore) {
      const sqliteIndex = Number.isInteger(chunk?._sqliteIndex)
        ? chunk._sqliteIndex
        : Number.isInteger(chunk?.index)
          ? chunk.index
          : resolved;
      if (Number.isInteger(sqliteIndex)) {
        return this.sqliteStore.getVector(sqliteIndex);
      }
    }
    return null;
  }

  async getChunkContent(chunk, index = null) {
    if (typeof chunk === 'number') {
      const store = Array.isArray(this.vectorStore) ? this.vectorStore : null;
      const entry = store ? store[chunk] : null;
      if (entry) return await this.getChunkContent(entry, chunk);
      if (!store && this.binaryStore) {
        const content = await this.binaryStore.getContent(chunk);
        return content ?? '';  
      }
      if (!store && this.sqliteStore) {
        return this.sqliteStore.getContent(chunk) ?? '';
      }
      return '';
    }
    if (chunk?.content !== undefined && chunk?.content !== null) {
      return chunk.content;
    }
    if (this.binaryStore && Number.isInteger(chunk?._binaryIndex)) {
      const content = await this.binaryStore.getContent(chunk._binaryIndex);
      return content ?? '';  
    }
    const resolved = Number.isInteger(index) ? index : chunk?._index;
    if (this.binaryStore && !Array.isArray(this.vectorStore) && Number.isInteger(resolved)) {
      const content = await this.binaryStore.getContent(resolved);
      return content ?? '';  
    }
    if (this.sqliteStore) {
      const sqliteIndex = Number.isInteger(chunk?._sqliteIndex)
        ? chunk._sqliteIndex
        : Number.isInteger(chunk?.index)
          ? chunk.index
          : resolved;
      if (Number.isInteger(sqliteIndex)) {
        return this.sqliteStore.getContent(sqliteIndex) ?? '';
      }
    }
    return '';
  }

  deleteFileHash(file) {
    this.fileHashes.delete(file);
  }

  
  async removeFileFromStore(file) {
    if (!Array.isArray(this.vectorStore)) return;
    
    let w = 0;
    for (let r = 0; r < this.vectorStore.length; r++) {
      const chunk = this.vectorStore[r];
      if (chunk.file !== file) {
        chunk._index = w;
        this.vectorStore[w++] = chunk;
      }
    }
    this.vectorStore.length = w;

    
    this.invalidateAnnIndex();
    this.removeFileCallData(file);
    
    this.fileHashes.delete(file);
  }

  addToStore(chunk) {
    normalizeChunkVector(chunk);

    if (!Array.isArray(this.vectorStore)) {
      this.vectorStore = [];
    }

    const label = this.vectorStore.length;
    chunk._index = label;
    this.vectorStore.push(chunk);
    if (Array.isArray(this.annVectorCache) && this.annVectorCache.length === label) {
      this.annVectorCache.push(chunk.vector);
    }

    
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
    if (!chunk) return null;

    if (
      !Array.isArray(this.annVectorCache) ||
      this.annVectorCache.length !== this.vectorStore.length
    ) {
      this.annVectorCache = new Array(this.vectorStore.length);
    }

    const cached = this.annVectorCache[index];
    if (cached) return cached;

    let vec = null;
    if (chunk.vector) {
      vec = ensureFloat32(chunk.vector);
    } else if (this.binaryStore && Number.isInteger(chunk._binaryIndex)) {
      vec = this.binaryStore.getVector(chunk._binaryIndex);
    } else if (this.sqliteStore) {
      const sqliteIndex = Number.isInteger(chunk._sqliteIndex)
        ? chunk._sqliteIndex
        : Number.isInteger(chunk.index)
          ? chunk.index
          : index;
      if (Number.isInteger(sqliteIndex)) {
        vec = this.sqliteStore.getVector(sqliteIndex);
      }
    }

    if (!vec) return null;

    if (this.config.vectorStoreLoadMode !== 'disk') {
      chunk.vector = vec;
    }
    this.annVectorCache[index] = vec;
    return vec;
  }

  getAnnIndexPaths() {
    return {
      indexFile: path.join(this.config.cacheDirectory, ANN_INDEX_FILE),
      metaFile: path.join(this.config.cacheDirectory, ANN_META_FILE),
    };
  }

  

  
  async ensureAnnIndex() {
    if (!this.config.annEnabled) return null;
    if (!Array.isArray(this.vectorStore)) return null;
    if (this.vectorStore.length < (this.config.annMinChunks ?? 5000)) return null;
    if (this.annIndex && !this.annDirty) return this.annIndex;
    if (this.annLoading) return this.annLoading;

    this.annLoading = (async () => {
      try {
        const HierarchicalNSW = await loadHnswlib();
        if (!HierarchicalNSW) {
          if (hnswlibLoadError) {
            this.addInitError('loadHnswlib', hnswlibLoadError);
          }
          return null;
        }

        const dim =
          this.vectorStore[0]?.vector?.length ||
          this.binaryStore?.dim ||
          this.sqliteStore?.dim;
        if (!dim) return null;

        
        
        let dimensionMismatch = false;
        const sampleSize = Math.min(ANN_DIMENSION_SAMPLE_SIZE, this.vectorStore.length);
        const step = Math.max(1, Math.floor(this.vectorStore.length / sampleSize));
        for (let i = step; i < this.vectorStore.length; i += step) {
          const v = this.vectorStore[i]?.vector;
          if (v && v.length !== dim) {
            dimensionMismatch = true;
            console.warn(
              `[ANN] Dimension mismatch at index ${i}: expected ${dim}, got ${v.length}. ` +
                'This may indicate a config change mid-index. Consider full reindex.'
            );
            break;
          }
        }

        if (dimensionMismatch) {
          this.addInitError('ensureAnnIndex', `Vector dimension inconsistency detected. Expected ${dim}. Full reindex required.`);
          return null; 
        }

        if (!this.annDirty && this.config.annIndexCache !== false) {
          const loaded = await this.loadAnnIndexFromDisk(HierarchicalNSW, dim);
          if (loaded) return this.annIndex;
        }

        return await this.buildAnnIndex(HierarchicalNSW, dim);
      } finally {
        this.annLoading = null;
      }
    })();

    return this.annLoading;
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
      console.info(`[ANN] Loaded ANN index (${meta.count} vectors, cap=${maxElements})`);
    }
    return true;
  }

  async buildAnnIndex(HierarchicalNSW, dim) {
    if (!Array.isArray(this.vectorStore)) return null;
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
            console.info(`[ANN] Saved ANN index (${total} vectors, cap=${maxElements})`);
          }
        } catch (error) {
          console.warn(`[ANN] Failed to save ANN index: ${error.message}`);
        }
      }

      return index;
    } catch (error) {
      console.warn(`[ANN] Failed to build ANN index: ${error.message}`);
      this.addInitError('buildAnnIndex', error);
      this.annIndex = null;
      this.annMeta = null;
      this.annDirty = true;
      this.annPersistDirty = false;
      return null;
    }
  }

  
  async queryAnn(queryVector, k) {
    if (!Array.isArray(this.vectorStore) || this.vectorStore.length === 0) return [];
    const index = await this.ensureAnnIndex();
    if (!index) return [];

    const qVec = queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector);
    
    
    let results;
    try {
      results = index.searchKnn(qVec, k);
    } catch (err) {
      console.warn(`[ANN] searchKnn failed: ${err.message}. Falling back to linear search.`);
      this.addInitError('queryAnn', err);
      
      this.invalidateAnnIndex();
      return [];
    }
    
    const labels = normalizeLabels(results);

    if (labels.length === 0) return [];

    const filtered = labels.filter(
      (label) => Number.isInteger(label) && label >= 0 && label < this.vectorStore.length
    );

    return filtered;
  }

  async clear() {
    if (!this.config.enableCache) return;

    try {
      await fs.rm(this.config.cacheDirectory, { recursive: true, force: true });
      this.vectorStore = [];
      if (this.binaryStore) {
        try {
          await this.binaryStore.close();
        } catch {
          
        }
      }
      this.binaryStore = null;
      if (this.sqliteStore) {
        try {
          this.sqliteStore.close();
        } catch {
          
        }
      }
      this.sqliteStore = null;
      this.fileHashes = new Map();
      this.invalidateAnnIndex();
      await this.clearCallGraphData();
      if (this.config.verbose) {
        console.info(`[Cache] Cache cleared successfully: ${this.config.cacheDirectory}`);
      }
    } catch (error) {
      console.error('[Cache] Failed to clear cache:', error.message);
      throw error;
    }
  }

  
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
        console.info(`[ANN] efSearch updated to ${efSearch} (applied to active index)`);
      }
      return { success: true, applied: true, efSearch };
    }

    if (this.config.verbose) {
      console.info(`[ANN] efSearch updated to ${efSearch} (will apply on next index build)`);
    }
    return { success: true, applied: false, efSearch };
  }

  
  getAnnStats() {
    return {
      enabled: this.config.annEnabled ?? false,
      indexLoaded: this.annIndex !== null,
      dirty: this.annDirty,
      vectorCount: Array.isArray(this.vectorStore) ? this.vectorStore.length : 0,
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

  getFileCallData(file) {
    return this.fileCallData.get(file);
  }

  hasFileCallData(file) {
    return this.fileCallData.has(file);
  }

  getFileCallDataKeys() {
    return Array.from(this.fileCallData.keys());
  }

  getFileCallDataCount() {
    return this.fileCallData.size;
  }

  
  setFileCallData(file, data) {
    this.fileCallData.set(file, data);
    this.callGraph = null;
  }

  
  setFileCallDataEntries(entries) {
    if (entries instanceof Map) {
      this.fileCallData = entries;
    } else {
      this.fileCallData.clear();
      if (entries && typeof entries === 'object') {
        for (const [file, data] of Object.entries(entries)) {
          this.fileCallData.set(file, data);
        }
      }
    }
    this.callGraph = null;
  }

  clearFileCallData() {
    this.fileCallData.clear();
    this.callGraph = null;
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
          console.info(
            `[CallGraph] Built graph: ${this.callGraph.defines.size} definitions, ${this.callGraph.calledBy.size} call targets`
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

  

  
  getStoreSize() {
    if (Array.isArray(this.vectorStore)) return this.vectorStore.length;
    if (this.binaryStore) return this.binaryStore.length;
    if (this.sqliteStore) return this.sqliteStore.length();
    return 0;
  }

  
  getVector(index) {
    return this.getChunkVector(index);
  }

  
  getChunk(index) {
    if (Array.isArray(this.vectorStore) && index >= 0 && index < this.vectorStore.length) {
      return this.vectorStore[index];
    }
    if (this.binaryStore) {
      const record = this.binaryStore.getRecord(index);
      if (record) {
        return {
          file: record.file,
          startLine: record.startLine,
          endLine: record.endLine,
          vector: this.binaryStore.getVector(index),
          _index: index,
          _binaryIndex: index,
        };
      }
    }
    if (this.sqliteStore) {
      const record = this.sqliteStore.getRecord(index);
      if (record) {
        return {
          file: record.file,
          startLine: record.startLine,
          endLine: record.endLine,
          vector: this.sqliteStore.getVector(index),
          _index: index,
          _sqliteIndex: index,
        };
      }
    }
    return null;
  }
}
