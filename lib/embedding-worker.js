import { parentPort, workerData } from 'worker_threads';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { pipeline, env } from '@xenova/transformers';
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
console.info = (...args) => console.error(...args);
console.warn = (...args) => console.error(...args);

// Dynamic thread configuration from main thread
// This allows optimal CPU usage (dynamic per system) without saturation.
const numThreads = workerData.numThreads || 1;
env.backends.onnx.wasm.numThreads = numThreads;
env.backends.onnx.numThreads = numThreads;

const RESULT_BATCH_SIZE = 25;
const workerId = Number.isInteger(workerData.workerId) ? workerData.workerId : null;
const workerLabel = workerId === null ? '[Worker]' : `[Worker ${workerId}]`;
const logInfo = (...args) => {
  console.info(...args);
};

function toFloat32Array(vector) {
  // Always create a copy to ensure we have a unique buffer for transfer
  // and avoid detaching shared WASM memory or overwriting reusable buffers
  return new Float32Array(vector);
}

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
            const model = await pipeline('feature-extraction', workerData.embeddingModel, {
              quantized: true,
            });
            const loadSeconds = ((Date.now() - modelLoadStart) / 1000).toFixed(1);
            logInfo(`${workerLabel} Embedding model ready: ${workerData.embeddingModel} (${loadSeconds}s)`);
            return model;
        } catch (err) {
            embedderPromise = null; // Reset promise so we can retry later
            throw err;
        }
    })();
  }
  return embedderPromise;
}

/**
 * Legacy Protocol: Process chunks with optimized single-text embedding
 * Streams results in batches.
 */
async function processChunks(chunks, batchId) {
  const embedder = await initializeEmbedder();
  let results = [];
  let transferList = [];

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
      const vector = toFloat32Array(output.data);
      results.push({
        file: chunk.file,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.text,
        vector,
        success: true,
      });
      transferList.push(vector.buffer);
    } catch (error) {
      results.push({
        file: chunk.file,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        error: error.message,
        success: false,
      });
    }
    flush();
  }

  flush(true);
  
  // Force GC if available to free massive tensor buffers immediately
  if (typeof global.gc === 'function') {
    global.gc();
  }
}

/**
 * New Protocol: Process entire file (read, chunk, embed) in worker.
 * Returns results once processing is complete.
 */
async function processFileTask(message) {
  const embedder = await initializeEmbedder();

  const file = message.file;
  const force = !!message.force;
  const expectedHash = message.expectedHash || null;

  // workerData.maxFileSize might not be set if using old config, default to Infinity
  const maxFileSize = Number.isFinite(workerData.maxFileSize) ? workerData.maxFileSize : Infinity;
  const callGraphEnabled = !!workerData.callGraphEnabled;

  let mtimeMs = null;
  let size = null;

  // 1) Get stats (if we were passed content, stats are best-effort or skipped for simplicity if not needed)
  if (!message.content) {
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
  }

  // 2) Read content (unless provided)
  let content;
  try {
    content = typeof message.content === 'string' ? message.content : await fs.readFile(file, 'utf-8');
  } catch (err) {
    return { status: 'skipped', reason: `read_failed: ${err.message}`, mtimeMs, size };
  }

  // Size check when content was provided
  if (message.content) {
    const byteSize = Buffer.byteLength(content, 'utf8');
    if (byteSize > maxFileSize) {
      return { status: 'skipped', reason: 'too_large', mtimeMs, size: byteSize };
    }
    size = byteSize;
  }

  // 3) Hash and unchanged short-circuit
  const hash = hashContent(content);
  if (!force && expectedHash && expectedHash === hash) {
    return { status: 'unchanged', hash, mtimeMs, size };
  }

  // 4) Call graph extraction (optional)
  let callData = null;
  if (callGraphEnabled) {
    try {
      callData = extractCallData(content, file);
    } catch {
      callData = null;
    }
  }

  // 5) Chunking in worker
  // Default to empty object if chunkConfig is missing
  const chunkConfig = workerData.chunkConfig || workerData.config || {};
  // If chunkConfig is missing model info, fall back to global workerData model
  if (!chunkConfig.embeddingModel) {
    chunkConfig.embeddingModel = workerData.embeddingModel;
  }

  const chunks = smartChunk(content, file, chunkConfig);

  // 6) Embed each chunk and prepare transferable results
  const results = [];
  const transferList = [];

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const output = await embedder(c.text, { pooling: 'mean', normalize: true });
    const vector = toFloat32Array(output.data);

    results.push({
      startLine: c.startLine,
      endLine: c.endLine,
      text: c.text,
      vectorBuffer: vector.buffer,
    });
    transferList.push(vector.buffer);
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
      const batchResults = [];
      const batchTransfer = [];

      for (const fileMsg of files) {
        try {
          // processFileTask returns { status, hash, mtimeMs, size, callData, results: [...chunks], transferList }
          const res = await processFileTask(fileMsg);
          
          // Add 'file' to the result so main thread knows which file this is
          res.file = fileMsg.file;
          
          if (res.transferList) {
            for (const buffer of res.transferList) {
              batchTransfer.push(buffer);
            }
            delete res.transferList;
          }
          
          batchResults.push(res);
        } catch (error) {
          batchResults.push({
            file: fileMsg.file,
            status: 'error',
            error: error.message
          });
        }
      }

      parentPort.postMessage({
        type: 'results',
        results: batchResults,
        batchId,
        done: true
      }, batchTransfer);
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
    if (message?.id) {
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
