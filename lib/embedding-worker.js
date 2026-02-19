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

const embeddingDimension = workerData.embeddingDimension || null;

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
        embedderPromise = null;
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

async function processChunks(chunks, batchId) {
  const embedder = await initializeEmbedder();
  let results = [];
  let transferList = [];
  const failFastState = createFailFastState('legacy chunk embedding');

  const flush = (done = false) => {
    if (!done && results.length < RESULT_BATCH_SIZE) return;

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

      const { data } = getEmbeddingTensor(output);
      let vector = new Float32Array(data);

      vector = sliceAndNormalize(vector, embeddingDimension);

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

  maybeRunGc();
}

async function prepareFileContent(file, providedContent, maxFileSize) {
  let mtimeMs = null;
  let size = null;
  let content = null;

  if (typeof providedContent === 'string') {
    content = providedContent;
    const byteSize = Buffer.byteLength(content, 'utf-8');
    if (byteSize > maxFileSize) {
      return { status: 'skipped', reason: 'too_large', size: byteSize };
    }
    size = byteSize;
    return { status: 'ok', content, mtimeMs, size };
  }

  try {
    const st = await fs.stat(file);
    if (st.isDirectory()) {
      return { status: 'skipped', reason: 'is_directory', mtimeMs: st.mtimeMs, size: st.size };
    }

    if (st.size > maxFileSize) {
      return { status: 'skipped', reason: 'too_large', mtimeMs: st.mtimeMs, size: st.size };
    }
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch (err) {
    return { status: 'skipped', reason: `stat_failed: ${err.message}` };
  }

  try {
    const handle = await fs.open(file, 'r');
    try {
      const bufferSize = Math.min(maxFileSize + 1, Math.max(size + 1024, 64 * 1024));
      const buffer = Buffer.alloc(bufferSize);
      const { bytesRead } = await handle.read(buffer, 0, bufferSize, 0);

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

function processFileMetadata(file, content, options) {
  const { force, expectedHash, callGraphEnabled, chunkConfig, workerLabel } = options;

  const hash = hashContent(content);
  if (!force && expectedHash && expectedHash === hash) {
    return { status: 'unchanged', hash, callData: null, chunks: [] };
  }

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

  const chunks = smartChunk(content, file, chunkConfig);

  return { status: 'processing', hash, callData, chunks };
}

async function processFileTask(message) {
  const embedder = await initializeEmbedder();
  const failFastState = createFailFastState(`file-task ${path.basename(message.file || '')}`);

  const file = message.file;
  const force = !!message.force;
  const expectedHash = message.expectedHash || null;

  if (!(await isPathInsideWorkspace(file))) {
    if (workerData.verbose) {
      console.warn(`[Worker ${workerData.workerId}] Skipping file outside workspace: ${file}`);
    }
    return { status: 'skipped', reason: 'outside_workspace' };
  }

  const maxFileSize = Number.isFinite(workerData.maxFileSize) ? workerData.maxFileSize : Infinity;
  const callGraphEnabled = !!workerData.callGraphEnabled;

  const prep = await prepareFileContent(file, message.content, maxFileSize);
  if (prep.status !== 'ok') {
    return { status: prep.status, reason: prep.reason, mtimeMs: prep.mtimeMs, size: prep.size };
  }
  const { content, mtimeMs, size } = prep;

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

  const results = [];
  const transferList = [];

  const INFERENCE_BATCH_SIZE = Number.isInteger(workerData.inferenceBatchSize)
    ? workerData.inferenceBatchSize
    : DEFAULT_INFERENCE_BATCH_SIZE;
  let processedSinceGc = 0;

  for (let i = 0; i < chunks.length; i += INFERENCE_BATCH_SIZE) {
    const batchChunks = chunks.slice(i, i + INFERENCE_BATCH_SIZE);
    const batchTexts = batchChunks.map((c) => c.text);

    try {
      const output = await embedder(batchTexts, {
        pooling: 'mean',
        normalize: true,
      });

      const { data, hiddenSize } = getEmbeddingTensor(output, {
        requireDimsForBatch: true,
        batchSize: batchChunks.length,
      });

      for (let j = 0; j < batchChunks.length; j++) {
        const c = batchChunks[j];

        const start = j * hiddenSize;
        const end = start + hiddenSize;
        const vectorView =
          typeof data.subarray === 'function' ? data.subarray(start, end) : data.slice(start, end);

        let vector = new Float32Array(vectorView);

        vector = sliceAndNormalize(vector, embeddingDimension);

        results.push({
          startLine: c.startLine,
          endLine: c.endLine,
          text: c.text,
          vectorBuffer: vector.buffer,
        });
        transferList.push(vector.buffer);
      }

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
        `${workerLabel} Batch inference failed (${err.name}), retrying individually: ${err.message}`
      );
      noteEmbeddingFailure(failFastState, err);

      for (const c of batchChunks) {
        try {
          const output = await embedder(c.text, { pooling: 'mean', normalize: true });
          const { data } = getEmbeddingTensor(output);
          let vector = new Float32Array(data);

          vector = sliceAndNormalize(vector, embeddingDimension);

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
          console.warn(`${workerLabel} Chunk embedding failed: ${innerErr.message}`);

          noteEmbeddingFailure(failFastState, innerErr);
          if (isFatalRuntimeEmbeddingError(innerErr)) {
            throw innerErr;
          }
        }
      }
    }

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

parentPort.on('message', async (message) => {
  try {
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'shutdown') {
      process.exit(0);
      return;
    }

    if (message.type === 'unload') {
      const wasLoaded = embedderPromise !== null;

      if (embedderPromise) {
        try {
          const embedder = await embedderPromise;

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

        embedderPromise = null;
      }

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

    if (message.type === 'processFile') {
      const { id } = message;
      if (!id) {
        parentPort.postMessage({ type: 'error', error: 'processFile missing id' });
        return;
      }

      const res = await processFileTask(message);

      if (res && res.transferList && res.transferList.length > 0) {
        const { transferList, ...payload } = res;
        parentPort.postMessage({ id, ...payload }, transferList);
      } else {
        parentPort.postMessage({ id, ...res });
      }
      return;
    }

    if (message.type === 'processFiles') {
      const { files, batchId } = message;
      const batchTransfer = [];
      const failFastState = createFailFastState('cross-file batch embedding');
      const PROGRESS_HEARTBEAT_MS = 15_000;
      let lastProgressAt = 0;
      const sendProgress = (payload = {}, { force = false } = {}) => {
        const now = Date.now();
        if (!force && now - lastProgressAt < PROGRESS_HEARTBEAT_MS) {
          return;
        }
        lastProgressAt = now;
        parentPort.postMessage({
          type: 'progress',
          batchId,
          ...payload,
        });
      };

      sendProgress(
        {
          stage: 'prepare',
          filesCompleted: 0,
          filesTotal: Array.isArray(files) ? files.length : 0,
        },
        { force: true }
      );

      const fileTasks = [];
      const allPendingChunks = [];

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

          if ((i + 1) % 100 === 0) {
            maybeRunGc();
          }

          if (chunks.length > 0) {
            for (const c of chunks) {
              allPendingChunks.push({
                fileIndex: i,
                text: c.text,
                startLine: c.startLine,
                endLine: c.endLine,
                vectorBuffer: null,
              });
            }
          }

          fileTasks.push({
            file: fileMsg.file,
            status: 'indexed',
            reason: null,
            hash,
            mtimeMs,
            size,
            callData,
            expectedChunks: chunkCount,
            results: [],
          });
        } catch (error) {
          fileTasks.push({
            file: fileMsg.file,
            status: 'error',
            error: error.message,
            expectedChunks: 0,
            results: [],
          });
        } finally {
          sendProgress({
            stage: 'prepare',
            filesCompleted: i + 1,
            filesTotal: files.length,
          });
        }
      }

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

              const vector = sliceAndNormalize(new Float32Array(vectorView), embeddingDimension);

              batchSlice[j].vectorBuffer = vector.buffer;
              batchTransfer.push(vector.buffer);
            }

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

            for (const item of batchSlice) {
              try {
                const output = await embedder(item.text, { pooling: 'mean', normalize: true });
                const { data } = getEmbeddingTensor(output);

                const vector = sliceAndNormalize(new Float32Array(data), embeddingDimension);

                if (typeof output.dispose === 'function')
                  try {
                    output.dispose();
                  } catch (disposeErr) {
                    if (workerData.verbose) {
                      console.warn(
                        `${workerLabel} Failed to dispose tensor: ${disposeErr.message}`
                      );
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

          sendProgress({
            stage: 'embed',
            chunksCompleted: Math.min(i + batchSlice.length, allPendingChunks.length),
            chunksTotal: allPendingChunks.length,
          });

          if (allPendingChunks.length > 50 && i % 50 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      }

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

      const resultsForTransfer = fileTasks.map((task) => ({
        ...task,
        results: task.results.map((r) => ({
          startLine: r.startLine,
          endLine: r.endLine,
          text: r.text,
          vectorBuffer: r.vectorBuffer,
        })),
      }));

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

      batchTransfer.length = 0;
      maybeRunGc();
      return;
    }

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

    parentPort.postMessage({ type: 'error', error: `Unknown message type: ${message.type}` });
  } catch (error) {
    if (message && typeof message === 'object' && message.id) {
      parentPort.postMessage({ id: message.id, error: error.message });
    } else {
      parentPort.postMessage({ type: 'error', error: error.message, batchId: message?.batchId });
    }
  }
});

initializeEmbedder()
  .then(() => {
    parentPort.postMessage({ type: 'ready' });
  })
  .catch((error) => {
    parentPort.postMessage({ type: 'error', error: error.message });
  });
