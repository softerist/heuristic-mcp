import { parentPort, workerData } from 'worker_threads';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { pipeline, env } from '@huggingface/transformers';
import { configureNativeOnnxBackend } from './onnx-backend.js';
import { smartChunk, hashContent } from './utils.js';
import { extractCallData } from './call-graph.js';

// Helper to get global cache dir (duplicated from config.js to avoid full config load in worker)
function getGlobalCacheDir() {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches');
  }
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
}

// Override console.info/warn to write to stderr so we don't break the MCP JSON-RPC protocol on stdout
// Labels help distinguish worker output from main thread during debugging
console.info = (...args) => console.error('[INFO]', ...args);
console.warn = (...args) => console.error('[WARN]', ...args);

import { RESULT_BATCH_SIZE, DEFAULT_INFERENCE_BATCH_SIZE } from './constants.js';
const workerId = Number.isInteger(workerData.workerId) ? workerData.workerId : null;
const workerLabel = workerId === null ? '[Worker]' : `[Worker ${workerId}]`;
const workerThreads = Number.isFinite(workerData.numThreads) ? workerData.numThreads : 1;
const explicitGcEnabled = workerData.enableExplicitGc !== false;
const failFastEmbeddingErrors = workerData.failFastEmbeddingErrors === true;
const FAIL_FAST_CONSECUTIVE_ERROR_LIMIT = 8;
const logInfo = (...args) => {
  console.info(...args);
};
let nativeBackendConfigured = false;

function maybeRunGc() {
  if (!explicitGcEnabled || typeof global.gc !== 'function') return;
  global.gc();
}

function createFailFastState(scope) {
  if (!failFastEmbeddingErrors) return null;
  return { scope, consecutiveFailures: 0 };
}

function noteEmbeddingSuccess(failFastState) {
  if (!failFastState) return;
  failFastState.consecutiveFailures = 0;
}

function noteEmbeddingFailure(failFastState, err) {
  if (!failFastState) return;
  failFastState.consecutiveFailures += 1;

  if (failFastState.consecutiveFailures >= FAIL_FAST_CONSECUTIVE_ERROR_LIMIT) {
    const message =
      `${failFastState.scope}: fail-fast breaker tripped after ` +
      `${failFastState.consecutiveFailures} consecutive embedding failures (${err?.message || err})`;
    console.warn(`${workerLabel} ${message}`);
    throw new Error(message);
  }

  if (workerData.verbose) {
    console.warn(
      `${workerLabel} ${failFastState.scope}: embedding failure ` +
      `${failFastState.consecutiveFailures}/${FAIL_FAST_CONSECUTIVE_ERROR_LIMIT}`
    );
  }
}

function ensureNativeBackend() {
  if (nativeBackendConfigured) return;
  configureNativeOnnxBackend({
    log: logInfo,
    label: workerLabel,
    threads: {
      intraOpNumThreads: workerThreads,
      interOpNumThreads: 1,
    },
  });
  nativeBackendConfigured = true;
}

const workspaceRoot = workerData.searchDirectory
  ? path.resolve(workerData.searchDirectory)
  : path.resolve(process.cwd());
const normalizedWorkspaceRoot =
  process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot;
if (!workerData.searchDirectory) {
  console.warn(
    `${workerLabel} searchDirectory not provided; defaulting to process.cwd() for containment checks.`
  );
}
let workspaceRootReal = null;
let workspaceRootRealPromise = null;

function resolveWorkerPath(targetPath) {
  if (!targetPath) return null;
  if (path.isAbsolute(targetPath)) {
    return path.resolve(targetPath);
  }
  if (workspaceRoot) {
    return path.resolve(workspaceRoot, targetPath);
  }
  return path.resolve(targetPath);
}

async function resolveWorkspaceRootReal() {
  if (!workspaceRoot) return null;
  if (workspaceRootReal) return workspaceRootReal;
  if (!workspaceRootRealPromise) {
    workspaceRootRealPromise = fs
      .realpath(workspaceRoot)
      .then((real) => {
        workspaceRootReal = real;
        return real;
      })
      .catch(() => {
        workspaceRootReal = workspaceRoot;
        return workspaceRoot;
      });
  }
  return workspaceRootRealPromise;
}

async function isPathInsideWorkspace(targetPath) {
  if (!workspaceRoot) return true;
  const resolved = resolveWorkerPath(targetPath);
  if (!resolved) return false;
  const baseReal = await resolveWorkspaceRootReal();
  try {
    const targetReal = await fs.realpath(resolved);
    const normalizedBase = process.platform === 'win32' ? baseReal.toLowerCase() : baseReal;
    const normalizedTarget = process.platform === 'win32' ? targetReal.toLowerCase() : targetReal;
    const rel = path.relative(normalizedBase, normalizedTarget);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    const normalizedResolved = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const rel = path.relative(normalizedWorkspaceRoot, normalizedResolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }
}

// NOTE: sliceAndNormalize is duplicated here because worker_threads run in a
// separate context and dynamic imports add latency. The canonical implementation
// is in lib/slice-normalize.js. Changes should be synchronized.
// IMPORTANT: test/slice-normalize-sync.test.js verifies both implementations match.
function sliceAndNormalize(vector, targetDim) {
  if (!targetDim || targetDim >= vector.length) {
    return vector;
  }
  const sliced = vector.slice(0, targetDim);
  let sumSquares = 0;
  for (let i = 0; i < targetDim; i++) {
    sumSquares += sliced[i] * sliced[i];
  }
  const norm = Math.sqrt(sumSquares);
  if (norm > 0) {
    for (let i = 0; i < targetDim; i++) {
      sliced[i] /= norm;
    }
  }
  return sliced;
}

// Get embedding dimension from workerData (null = full dimensions)
const embeddingDimension = workerData.embeddingDimension || null;

// Initialize the embedding model once when worker starts
// Use a promise to handle concurrent calls to initializeEmbedder safely
let embedderPromise = null;

async function initializeEmbedder() {
  if (!embedderPromise) {
    const modelLoadStart = Date.now();

    // Ensure we use the global cache directory
    env.cacheDir = path.join(getGlobalCacheDir(), 'xenova');

    logInfo(`${workerLabel} Embedding model load started: ${workerData.embeddingModel}`);

    embedderPromise = (async () => {
      try {
        ensureNativeBackend();
        const model = await pipeline('feature-extraction', workerData.embeddingModel, {
          quantized: true,
          dtype: 'fp32',
          session_options: {
            numThreads: workerThreads,
            intraOpNumThreads: workerThreads,
            interOpNumThreads: 1,
          },
        });
        const loadSeconds = ((Date.now() - modelLoadStart) / 1000).toFixed(1);
        logInfo(
          `${workerLabel} Embedding model ready: ${workerData.embeddingModel} (${loadSeconds}s)`
        );
        return model;
      } catch (err) {
        embedderPromise = null; // Reset promise so we can retry later
        throw err;
      }
    })();
  }
  return embedderPromise;
}

function isFatalRuntimeEmbeddingError(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return (
    message.includes('exception is pending') ||
    message.includes('invalid embedding output') ||
    message.includes("cannot read properties of undefined (reading 'data')") ||
    message.includes("cannot read properties of null (reading 'data')")
  );
}

function getEmbeddingTensor(output, { requireDimsForBatch = false, batchSize = null } = {}) {
  const data = output?.data;
  if (!data || typeof data.length !== 'number') {
    throw new Error('Invalid embedding output: missing tensor data');
  }
  if (!requireDimsForBatch) {
    return { data };
  }

  const dims = Array.isArray(output?.dims) ? output.dims : null;
  const hiddenSize = Number.isInteger(dims?.[dims.length - 1]) ? dims[dims.length - 1] : null;
  if (!hiddenSize || hiddenSize <= 0) {
    throw new Error('Invalid embedding output: missing tensor dims');
  }
  if (Number.isInteger(batchSize) && batchSize > 0 && data.length < hiddenSize * batchSize) {
    throw new Error('Invalid embedding output: tensor length mismatch');
  }
  return { data, hiddenSize };
}

/**
 * Legacy Protocol: Process chunks with optimized single-text embedding
 * Streams results in batches.
 */
async function processChunks(chunks, batchId) {
  const embedder = await initializeEmbedder();
  let results = [];
  let transferList = [];
  const failFastState = createFailFastState('legacy chunk embedding');

  const flush = (done = false) => {
    // Only flush intermediate results when we have enough for a batch
    if (!done && results.length < RESULT_BATCH_SIZE) return;

    // final batch might be empty if chunks was empty or perfectly divisible by RESULT_BATCH_SIZE
    // but we still send it to signal we are done.

    const payload = {
      type: 'results',
      results,
      batchId,
      done,
    };
    if (transferList.length > 0) {
      parentPort.postMessage(payload, transferList);
    } else {
      parentPort.postMessage(payload);
    }
    results = [];
    transferList = [];
  };

  for (const chunk of chunks) {
    try {
      const output = await embedder(chunk.text, {
        pooling: 'mean',
        normalize: true,
      });
      // CRITICAL: Deep copy to release ONNX tensor memory
      const { data } = getEmbeddingTensor(output);
      let vector = new Float32Array(data);
      // Apply MRL dimension slicing if configured
      vector = sliceAndNormalize(vector, embeddingDimension);
      // Properly dispose tensor to release ONNX runtime memory
      if (typeof output.dispose === 'function')
        try {
          output.dispose();
        } catch (disposeErr) {
          if (workerData.verbose) {
            console.warn(`${workerLabel} Failed to dispose tensor: ${disposeErr.message}`);
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
      transferList.push(vector.buffer);
      noteEmbeddingSuccess(failFastState);
    } catch (error) {
      results.push({
        file: chunk.file,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        error: error.message,
        success: false,
      });
      noteEmbeddingFailure(failFastState, error);
      if (isFatalRuntimeEmbeddingError(error)) {
        throw error;
      }
    }
    flush();
  }

  flush(true);

  // Force GC if available to free massive tensor buffers immediately
  maybeRunGc();
}

// =====================================================================
// SHARED HELPER FUNCTIONS
// =====================================================================

/**
 * Prepares file content for processing: stat, size check, read content.
 * @param {string} file - File path
 * @param {string|null} providedContent - Pre-provided content (optional)
 * @param {number} maxFileSize - Maximum allowed file size
 * @returns {Promise<{status: string, reason?: string, content?: string, mtimeMs?: number, size?: number}>}
 */
async function prepareFileContent(file, providedContent, maxFileSize) {
  let mtimeMs = null;
  let size = null;
  let content = null;

  // Handle pre-provided content
  if (typeof providedContent === 'string') {
    content = providedContent;
    const byteSize = Buffer.byteLength(content, 'utf-8');
    if (byteSize > maxFileSize) {
      return { status: 'skipped', reason: 'too_large', size: byteSize };
    }
    size = byteSize;
    return { status: 'ok', content, mtimeMs, size };
  }

  // Stat the file
  try {
    const st = await fs.stat(file);
    if (st.isDirectory()) {
      return { status: 'skipped', reason: 'is_directory', mtimeMs: st.mtimeMs, size: st.size };
    }
    // NOTE: TOCTOU race between stat and readFile - file could grow after this check.
    // Risk: Memory exhaustion if file grows significantly between stat and read.
    // Mitigation: Process isolation (workers), soft limit (not security boundary),
    // and Node.js readFile will throw ENOMEM before crashing the process.
    if (st.size > maxFileSize) {
      return { status: 'skipped', reason: 'too_large', mtimeMs: st.mtimeMs, size: st.size };
    }
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch (err) {
    return { status: 'skipped', reason: `stat_failed: ${err.message}` };
  }

  // Read content with size limit to mitigate TOCTOU race
  try {
    const handle = await fs.open(file, 'r');
    try {
      // Defense-in-depth: Allocate enough to detect files that grow beyond limit.
      // We use maxFileSize + 1 (capped at 64MB) to reliably detect overflow without
      // excessive memory allocation for small files.
      const bufferSize = Math.min(maxFileSize + 1, Math.max(size + 1024, 64 * 1024));
      const buffer = Buffer.alloc(bufferSize);
      const { bytesRead } = await handle.read(buffer, 0, bufferSize, 0);
      
      // Reject if file grew beyond limit between stat and read
      if (bytesRead > maxFileSize) {
        return { status: 'skipped', reason: 'too_large_after_read', mtimeMs, size: bytesRead };
      }
      
      content = buffer.slice(0, bytesRead).toString('utf-8');
      size = bytesRead;
    } finally {
      await handle.close();
    }
  } catch (err) {
    return { status: 'skipped', reason: `read_failed: ${err.message}`, mtimeMs, size };
  }

  return { status: 'ok', content, mtimeMs, size };
}

/**
 * Processes file metadata: hash check, call graph, chunking.
 * @param {string} file - File path
 * @param {string} content - File content
 * @param {object} options - { force, expectedHash, callGraphEnabled, chunkConfig, workerLabel }
 * @returns {{status: string, hash: string, callData: object|null, chunks: Array}}
 */
function processFileMetadata(file, content, options) {
  const { force, expectedHash, callGraphEnabled, chunkConfig, workerLabel } = options;

  // Hash and unchanged short-circuit
  const hash = hashContent(content);
  if (!force && expectedHash && expectedHash === hash) {
    return { status: 'unchanged', hash, callData: null, chunks: [] };
  }

  // Call graph extraction (optional)
  let callData = null;
  if (callGraphEnabled) {
    try {
      callData = extractCallData(content, file);
    } catch (err) {
      console.warn(
        `${workerLabel} Call graph extraction failed for ${path.basename(file)}: ${err.message}`
      );
      callData = null;
    }
  }

  // Chunking
  const chunks = smartChunk(content, file, chunkConfig);

  return { status: 'processing', hash, callData, chunks };
}

/**
 * New Protocol: Process entire file (read, chunk, embed) in worker.
 * Returns results once processing is complete.
 */
async function processFileTask(message) {
  const embedder = await initializeEmbedder();
  const failFastState = createFailFastState(`file-task ${path.basename(message.file || '')}`);

  const file = message.file;
  const force = !!message.force;
  const expectedHash = message.expectedHash || null;

  // Check workspace boundary
  if (!(await isPathInsideWorkspace(file))) {
    if (workerData.verbose) {
      console.warn(`[Worker ${workerData.workerId}] Skipping file outside workspace: ${file}`);
    }
    return { status: 'skipped', reason: 'outside_workspace' };
  }

  const maxFileSize = Number.isFinite(workerData.maxFileSize) ? workerData.maxFileSize : Infinity;
  const callGraphEnabled = !!workerData.callGraphEnabled;

  // 1-2) Prepare file content using shared helper
  const prep = await prepareFileContent(file, message.content, maxFileSize);
  if (prep.status !== 'ok') {
    return { status: prep.status, reason: prep.reason, mtimeMs: prep.mtimeMs, size: prep.size };
  }
  const { content, mtimeMs, size } = prep;

  // 3-5) Hash, call graph, chunking using shared helper
  const chunkConfig = {
    ...(workerData.config || {}),
    ...(workerData.chunkConfig || {}),
    ...(message.chunkConfig || {}),
  };
  if (!chunkConfig.embeddingModel) chunkConfig.embeddingModel = workerData.embeddingModel;

  const meta = processFileMetadata(file, content, {
    force,
    expectedHash,
    callGraphEnabled,
    chunkConfig,
    workerLabel,
  });

  if (meta.status === 'unchanged') {
    return { status: 'unchanged', hash: meta.hash, mtimeMs, size };
  }

  const { hash, callData, chunks } = meta;

  // 6) Embed chunks in batches for performance
  const results = [];
  const transferList = [];

  // Batch size for inference (balance between speed and memory)
  // Configurable via workerData, default 4 balances memory and throughput
  const INFERENCE_BATCH_SIZE = Number.isInteger(workerData.inferenceBatchSize)
    ? workerData.inferenceBatchSize
    : DEFAULT_INFERENCE_BATCH_SIZE;
  let processedSinceGc = 0;

  for (let i = 0; i < chunks.length; i += INFERENCE_BATCH_SIZE) {
    const batchChunks = chunks.slice(i, i + INFERENCE_BATCH_SIZE);
    const batchTexts = batchChunks.map((c) => c.text);

    try {
      // Run inference on the batch
      const output = await embedder(batchTexts, {
        pooling: 'mean',
        normalize: true,
      });

      // Output is a Tensor with shape [batch_size, hidden_size]
      // data is a flat Float32Array
      const { data, hiddenSize } = getEmbeddingTensor(output, {
        requireDimsForBatch: true,
        batchSize: batchChunks.length,
      });

      for (let j = 0; j < batchChunks.length; j++) {
        const c = batchChunks[j];

        // Slice the flat buffer to get this chunk's vector
        // specific slice for this element
        const start = j * hiddenSize;
        const end = start + hiddenSize;
        const vectorView =
          typeof data.subarray === 'function' ? data.subarray(start, end) : data.slice(start, end);

        // Deep copy to ensure independent buffer for transfer
        let vector = new Float32Array(vectorView);
        // Apply MRL dimension slicing if configured
        vector = sliceAndNormalize(vector, embeddingDimension);

        results.push({
          startLine: c.startLine,
          endLine: c.endLine,
          text: c.text,
          vectorBuffer: vector.buffer,
        });
        transferList.push(vector.buffer);
      }
      // Properly dispose tensor to release ONNX runtime memory
      if (typeof output.dispose === 'function')
        try {
          output.dispose();
        } catch (disposeErr) {
          if (workerData.verbose) {
            console.warn(`${workerLabel} Failed to dispose tensor: ${disposeErr.message}`);
          }
        }
      noteEmbeddingSuccess(failFastState);
    } catch (err) {
      if (isFatalRuntimeEmbeddingError(err)) {
        noteEmbeddingFailure(failFastState, err);
        throw err;
      }
      // Fallback: if batch fails (e.g. OOM), try one by one for this batch
      console.warn(`${workerLabel} Batch inference failed (${err.name}), retrying individually: ${err.message}`);
      noteEmbeddingFailure(failFastState, err);

      for (const c of batchChunks) {
        try {
          const output = await embedder(c.text, { pooling: 'mean', normalize: true });
          const { data } = getEmbeddingTensor(output);
          let vector = new Float32Array(data);
          // Apply MRL dimension slicing if configured
          vector = sliceAndNormalize(vector, embeddingDimension);
          // Properly dispose tensor to release ONNX runtime memory
          if (typeof output.dispose === 'function')
            try {
              output.dispose();
            } catch (disposeErr) {
              if (workerData.verbose) {
                console.warn(`${workerLabel} Failed to dispose tensor: ${disposeErr.message}`);
              }
            }
          results.push({
            startLine: c.startLine,
            endLine: c.endLine,
            text: c.text,
            vectorBuffer: vector.buffer,
          });
          transferList.push(vector.buffer);
          noteEmbeddingSuccess(failFastState);
        } catch (innerErr) {
          // Note: No tensor disposal needed - embedder() threw before returning a tensor
          console.warn(`${workerLabel} Chunk embedding failed: ${innerErr.message}`);
          // We omit this chunk from results, effectively skipping it
          noteEmbeddingFailure(failFastState, innerErr);
          if (isFatalRuntimeEmbeddingError(innerErr)) {
            throw innerErr;
          }
        }
      }
    }

    // Yield to event loop briefly between batches and trigger GC
    processedSinceGc += batchChunks.length;
    if (chunks.length > INFERENCE_BATCH_SIZE) {
      if (processedSinceGc >= 100) {
        maybeRunGc();
        processedSinceGc = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return { status: 'indexed', hash, mtimeMs, size, callData, results, transferList };
}

// Listen for messages from main thread
parentPort.on('message', async (message) => {
  try {
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'shutdown') {
      process.exit(0);
      return;
    }

    // Unload model to free memory
    if (message.type === 'unload') {
      const wasLoaded = embedderPromise !== null;
      
      if (embedderPromise) {
        try {
          const embedder = await embedderPromise;
          // Try to dispose the pipeline if it has a dispose method
          if (embedder && typeof embedder.dispose === 'function') {
            try {
              await embedder.dispose();
              logInfo(`${workerLabel} Model disposed successfully`);
            } catch (disposeErr) {
              logInfo(`${workerLabel} Model dispose warning: ${disposeErr.message}`);
            }
          }
        } catch (err) {
          logInfo(`${workerLabel} Error during model unload: ${err.message}`);
        }
        
        // Clear references
        embedderPromise = null;
      }
      
      // Trigger garbage collection if available
      if (explicitGcEnabled && typeof global.gc === 'function') {
        const before = process.memoryUsage();
        global.gc();
        const after = process.memoryUsage();
        logInfo(
          `${workerLabel} Post-unload GC: rss ${(before.rss / 1024 / 1024).toFixed(1)}MB -> ${(after.rss / 1024 / 1024).toFixed(1)}MB`
        );
      }
      
      parentPort.postMessage({ type: 'unload-complete', success: true, wasLoaded });
      return;
    }

    // ---- New protocol: file-level processing (chunking + embedding in worker) ----
    if (message.type === 'processFile') {
      const { id } = message;
      if (!id) {
        parentPort.postMessage({ type: 'error', error: 'processFile missing id' });
        return;
      }

      const res = await processFileTask(message);

      // Transfer vectors if present
      if (res && res.transferList && res.transferList.length > 0) {
        const { transferList, ...payload } = res;
        parentPort.postMessage({ id, ...payload }, transferList);
      } else {
        parentPort.postMessage({ id, ...res });
      }
      return;
    }

    // ---- Batch file processing ----
    if (message.type === 'processFiles') {
      const { files, batchId } = message;
      const batchTransfer = [];
      const failFastState = createFailFastState('cross-file batch embedding');

      // 1. Pre-process all files: Read, Stat, and Chunk
      // We do this first to gather a massive list of chunks for batched inference
      const fileTasks = [];
      const allPendingChunks = []; // { text, fileIndex, chunkIndex, startLine, endLine }

      for (let i = 0; i < files.length; i++) {
        const fileMsg = files[i];

        try {
          const file = fileMsg.file;
          const force = !!fileMsg.force;
          const expectedHash = fileMsg.expectedHash || null;
          const maxFileSize = Number.isFinite(workerData.maxFileSize)
            ? workerData.maxFileSize
            : Infinity;
          const callGraphEnabled = !!workerData.callGraphEnabled;

          // Check workspace boundary first
          if (!(await isPathInsideWorkspace(file))) {
            fileTasks.push({
              file: fileMsg.file,
              status: 'skipped',
              reason: 'outside_workspace',
              hash: null,
              mtimeMs: null,
              size: null,
              callData: null,
              expectedChunks: 0,
              results: [],
            });
            continue;
          }

          // Use shared helper for file preparation
          const prep = await prepareFileContent(file, fileMsg.content, maxFileSize);
          if (prep.status !== 'ok') {
            fileTasks.push({
              file: fileMsg.file,
              status: prep.status,
              reason: prep.reason,
              hash: null,
              mtimeMs: prep.mtimeMs,
              size: prep.size,
              callData: null,
              expectedChunks: 0,
              results: [],
            });
            continue;
          }

          const { content, mtimeMs, size } = prep;

          // Use shared helper for metadata processing
          const chunkConfig = {
            ...(workerData.config || {}),
            ...(workerData.chunkConfig || {}),
            ...(message.chunkConfig || {}),
          };
          if (!chunkConfig.embeddingModel) chunkConfig.embeddingModel = workerData.embeddingModel;

          const meta = processFileMetadata(file, content, {
            force,
            expectedHash,
            callGraphEnabled,
            chunkConfig,
            workerLabel,
          });

          if (meta.status === 'unchanged') {
            fileTasks.push({
              file: fileMsg.file,
              status: 'unchanged',
              reason: null,
              hash: meta.hash,
              mtimeMs,
              size,
              callData: null,
              expectedChunks: 0,
              results: [],
            });
            continue;
          }

          const { hash, callData, chunks } = meta;
          const chunkCount = chunks.length;

          // Trigger GC every 100 files
          if ((i + 1) % 100 === 0) {
            maybeRunGc();
          }

          // Register chunks for batching
          if (chunks.length > 0) {
            for (const c of chunks) {
              allPendingChunks.push({
                fileIndex: i,
                text: c.text,
                startLine: c.startLine,
                endLine: c.endLine,
                vectorBuffer: null, // to be filled
              });
            }
          }

          fileTasks.push({
            file: fileMsg.file,
            status: 'indexed', // Provisional, pending embedding
            reason: null,
            hash,
            mtimeMs,
            size,
            callData,
            expectedChunks: chunkCount,
            results: [], // Will store chunk results
          });
        } catch (error) {
          fileTasks.push({
            file: fileMsg.file,
            status: 'error',
            error: error.message,
            expectedChunks: 0,
            results: [],
          });
        }
      }

      // 2. Run Batched Inference on all accumulated chunks
      if (allPendingChunks.length > 0) {
        const embedder = await initializeEmbedder();
        const INFERENCE_BATCH_SIZE = Number.isInteger(workerData.inferenceBatchSize)
          ? workerData.inferenceBatchSize
          : DEFAULT_INFERENCE_BATCH_SIZE;

        for (let i = 0; i < allPendingChunks.length; i += INFERENCE_BATCH_SIZE) {
          const batchSlice = allPendingChunks.slice(i, i + INFERENCE_BATCH_SIZE);
          const batchTexts = batchSlice.map((c) => c.text);

          try {
            const output = await embedder(batchTexts, { pooling: 'mean', normalize: true });
            const { data, hiddenSize } = getEmbeddingTensor(output, {
              requireDimsForBatch: true,
              batchSize: batchSlice.length,
            });

            for (let j = 0; j < batchSlice.length; j++) {
              const start = j * hiddenSize;
              const end = start + hiddenSize;
              const vectorView =
                typeof data.subarray === 'function'
                  ? data.subarray(start, end)
                  : data.slice(start, end);
              // Deep copy the view to avoid WASM memory issues, then apply MRL slicing
              const vector = sliceAndNormalize(new Float32Array(vectorView), embeddingDimension);

              batchSlice[j].vectorBuffer = vector.buffer;
              batchTransfer.push(vector.buffer);
            }
            // Properly dispose tensor to release ONNX runtime memory
            if (typeof output.dispose === 'function')
              try {
                output.dispose();
              } catch (disposeErr) {
                if (workerData.verbose) {
                  console.warn(`${workerLabel} Failed to dispose tensor: ${disposeErr.message}`);
                }
            }
            noteEmbeddingSuccess(failFastState);
          } catch (err) {
            if (isFatalRuntimeEmbeddingError(err)) {
              noteEmbeddingFailure(failFastState, err);
              throw err;
            }
            console.warn(
              `${workerLabel} Cross-file batch inference failed, retrying individually: ${err.message}`
            );
            noteEmbeddingFailure(failFastState, err);
            // Fallback: individual embedding for this failed batch
            for (const item of batchSlice) {
              try {
                const output = await embedder(item.text, { pooling: 'mean', normalize: true });
                const { data } = getEmbeddingTensor(output);
                // Deep copy and apply MRL slicing
                const vector = sliceAndNormalize(new Float32Array(data), embeddingDimension);
                // Properly dispose tensor to release ONNX runtime memory
                if (typeof output.dispose === 'function')
                  try {
                    output.dispose();
                  } catch (disposeErr) {
                    if (workerData.verbose) {
                      console.warn(`${workerLabel} Failed to dispose tensor: ${disposeErr.message}`);
                    }
                  }
                item.vectorBuffer = vector.buffer;
                batchTransfer.push(vector.buffer);
                noteEmbeddingSuccess(failFastState);
              } catch (innerErr) {
                console.warn(`${workerLabel} Chunk embedding failed: ${innerErr.message}`);
                noteEmbeddingFailure(failFastState, innerErr);
                if (isFatalRuntimeEmbeddingError(innerErr)) {
                  throw innerErr;
                }
              }
            }
          }

          // Minimal yield to keep event loop breathing (optional, can be removed for max throughput)
          if (allPendingChunks.length > 50 && i % 50 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      }

      // 3. Reassemble results and validate
      for (const chunkItem of allPendingChunks) {
        if (chunkItem.vectorBuffer) {
          const task = fileTasks[chunkItem.fileIndex];
          task.results.push({
            startLine: chunkItem.startLine,
            endLine: chunkItem.endLine,
            text: chunkItem.text,
            vectorBuffer: chunkItem.vectorBuffer,
          });
        }
      }

      for (const task of fileTasks) {
        if (task.status === 'indexed' && task.expectedChunks > 0) {
          if (task.results.length !== task.expectedChunks) {
            task.status = 'error';
            task.error = `Embedding incomplete: ${task.results.length}/${task.expectedChunks} chunks`;
            task.errorType = 'partial_embedding';
            task.recoverable = true;
          }
        }
      }

      // 4. Send response
      // IMPORTANT: Clear vectorBuffer references BEFORE transfer to prevent use-after-transfer.
      // After postMessage with transfer list, the ArrayBuffers become detached and any
      // access to them (even for logging) would fail.
      const resultsForTransfer = fileTasks.map((task) => ({
        ...task,
        results: task.results.map((r) => ({
          startLine: r.startLine,
          endLine: r.endLine,
          text: r.text,
          vectorBuffer: r.vectorBuffer, // Will be transferred
        })),
      }));

      // Null out original references to avoid accidental access
      for (const task of fileTasks) {
        for (const r of task.results) {
          r.vectorBuffer = null;
        }
      }

      parentPort.postMessage(
        {
          type: 'results',
          results: resultsForTransfer,
          batchId,
          done: true,
        },
        batchTransfer
      );

      // Explicitly clear references and trigger GC
      batchTransfer.length = 0;
      maybeRunGc();
      return;
    }

    // ---- Legacy protocol: batch of chunks prepared by main thread ----
    if (message.type === 'process') {
      try {
        await processChunks(message.chunks || [], message.batchId);
      } catch (error) {
        parentPort.postMessage({
          type: 'error',
          error: error.message,
          batchId: message.batchId,
        });
      }
      return;
    }

    // Unknown type
    parentPort.postMessage({ type: 'error', error: `Unknown message type: ${message.type}` });
  } catch (error) {
    // If message had an id, respond via RPC style; otherwise legacy error
    if (message && typeof message === 'object' && message.id) {
      parentPort.postMessage({ id: message.id, error: error.message });
    } else {
      parentPort.postMessage({ type: 'error', error: error.message, batchId: message?.batchId });
    }
  }
});

// Signal that worker is ready
initializeEmbedder()
  .then(() => {
    parentPort.postMessage({ type: 'ready' });
  })
  .catch((error) => {
    parentPort.postMessage({ type: 'error', error: error.message });
  });
