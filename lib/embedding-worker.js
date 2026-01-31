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

const workspaceRoot = workerData.searchDirectory
  ? path.resolve(workerData.searchDirectory)
  : path.resolve(process.cwd());
const normalizedWorkspaceRoot = process.platform === 'win32'
  ? workspaceRoot.toLowerCase()
  : workspaceRoot;
if (!workerData.searchDirectory) {
  console.warn(`${workerLabel} searchDirectory not provided; defaulting to process.cwd() for containment checks.`);
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
    workspaceRootRealPromise = fs.realpath(workspaceRoot)
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
      // CRITICAL: Deep copy to release ONNX tensor memory
      const vector = new Float32Array(output.data);
      // Help GC by nullifying the large buffer reference
      try { output.data = null; } catch { /* frozen tensor */ }
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
  if (!(await isPathInsideWorkspace(file))) {
    return { status: 'skipped', reason: 'outside_workspace' };
  }

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
    } catch (err) {
      console.warn(`${workerLabel} Call graph extraction failed for ${path.basename(file)}: ${err.message}`);
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

  // 6) Embed chunks in batches for performance
  const results = [];
  const transferList = [];
  
  // Batch size for inference (balance between speed and memory)
  // Reduced from 16 to 4 to limit WASM memory accumulation
  const INFERENCE_BATCH_SIZE = 4;

  for (let i = 0; i < chunks.length; i += INFERENCE_BATCH_SIZE) {
    const batchChunks = chunks.slice(i, i + INFERENCE_BATCH_SIZE);
    const batchTexts = batchChunks.map(c => c.text);
    
    try {
      // Run inference on the batch
      const output = await embedder(batchTexts, { pooling: 'mean', normalize: true });
      
      // Output is a Tensor with shape [batch_size, hidden_size]
      // data is a flat Float32Array
      const hiddenSize = output.dims[output.dims.length - 1];
      
      for (let j = 0; j < batchChunks.length; j++) {
        const c = batchChunks[j];
        
        // Slice the flat buffer to get this chunk's vector
        // specific slice for this element
        const start = j * hiddenSize;
        const end = start + hiddenSize;
        const vectorView = output.data.subarray(start, end);
        
        // Deep copy to ensure independent buffer for transfer
        const vector = new Float32Array(vectorView);
        
        results.push({
          startLine: c.startLine,
          endLine: c.endLine,
          text: c.text,
          vectorBuffer: vector.buffer,
        });
        transferList.push(vector.buffer);
      }
      // Help GC by nullifying the large buffer reference (dispose() doesn't exist in transformers.js)
      try { output.data = null; } catch { /* frozen tensor */ }
    } catch (err) {
      // Fallback: if batch fails (e.g. OOM), try one by one for this batch
      console.warn(`${workerLabel} Batch inference failed, retrying individually: ${err.message}`);
      
      for (const c of batchChunks) {
        try {
           const output = await embedder(c.text, { pooling: 'mean', normalize: true });
           const vector = new Float32Array(output.data);
           // Help GC by nullifying the large buffer reference
           try { output.data = null; } catch { /* frozen tensor */ }
           results.push({
             startLine: c.startLine,
             endLine: c.endLine,
             text: c.text,
             vectorBuffer: vector.buffer,
           });
           transferList.push(vector.buffer);
        } catch (innerErr) {
           console.warn(`${workerLabel} Chunk embedding failed: ${innerErr.message}`);
           // We omit this chunk from results, effectively skipping it
        }
      }
    }
    
    // Yield to event loop briefly between batches and trigger GC
    if (chunks.length > INFERENCE_BATCH_SIZE) {
        if (typeof global.gc === 'function') global.gc();
        await new Promise(resolve => setTimeout(resolve, 0));
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

      // 1. Pre-process all files: Read, Stat, and Chunk
      // We do this first to gather a massive list of chunks for batched inference
      const fileTasks = [];
      const allPendingChunks = []; // { text, fileIndex, chunkIndex, startLine, endLine }

      for (let i = 0; i < files.length; i++) {
        const fileMsg = files[i];
        
        // We reuse processFileTask but we need to intercept the "embedding" phase
        // So we split processFileTask logic. 
        // For now, let's just duplicate the "prep" logic to avoid breaking single-file calls.
        
        try {
           const file = fileMsg.file;
           const force = !!fileMsg.force;
           const expectedHash = fileMsg.expectedHash || null;
           const maxFileSize = Number.isFinite(workerData.maxFileSize) ? workerData.maxFileSize : Infinity;
           const callGraphEnabled = !!workerData.callGraphEnabled;

           let mtimeMs = null;
           let size = null;
           let status = 'processing';
           let reason = null;
           let hash = null;
           let content = null;
           let callData = null;

           // A. Stat & Checks
           if (!fileMsg.content) {
             try {
               const st = await fs.stat(file);
               if (st.isDirectory()) {
                 status = 'skipped'; reason = 'is_directory'; mtimeMs = st.mtimeMs; size = st.size;
               } else if (st.size > maxFileSize) {
                 status = 'skipped'; reason = 'too_large'; mtimeMs = st.mtimeMs; size = st.size;
               } else {
                 mtimeMs = st.mtimeMs;
                 size = st.size;
               }
             } catch (err) {
                status = 'skipped'; reason = `stat_failed: ${err.message}`;
             }
           } else {
              // Content provided
              content = fileMsg.content;
              const byteSize = Buffer.byteLength(content, 'utf-8');
              if (byteSize > maxFileSize) {
                  status = 'skipped'; reason = 'too_large'; size = byteSize;
              } else {
                  size = byteSize;
              }
           }

           if (status === 'processing') {
             if (!(await isPathInsideWorkspace(file))) {
               status = 'skipped';
               reason = 'outside_workspace';
             }
           }

           if (status === 'processing') {
             // B. Read Content
             if (content === null) {
                try {
                  content = await fs.readFile(file, 'utf-8');
                } catch (err) {
                   status = 'skipped'; reason = `read_failed: ${err.message}`;
                }
             }
           }

           if (status === 'processing') {
              // C. Hash Check
              hash = hashContent(content);
              if (!force && expectedHash && expectedHash === hash) {
                 status = 'unchanged';
              }
           }

           if (status === 'processing') {
               // D. Call Graph
               if (callGraphEnabled) {
                  try {
                    callData = extractCallData(content, file);
                  } catch (err) {
                    console.warn(`${workerLabel} Call graph extraction failed for ${path.basename(file)}: ${err.message}`);
                    callData = null;
                  }
               }

               // E. Chunking
               const chunkConfig = message.chunkConfig || workerData.chunkConfig || workerData.config || {};
               if (!chunkConfig.embeddingModel) chunkConfig.embeddingModel = workerData.embeddingModel;
               
               const chunks = smartChunk(content, file, chunkConfig);
               const chunkCount = chunks.length;
               
               // Register chunks for batching
               if (chunks.length > 0) {
                   for (const c of chunks) {
                       allPendingChunks.push({
                           fileIndex: i,
                           text: c.text,
                           startLine: c.startLine,
                           endLine: c.endLine,
                           vectorBuffer: null // to be filled
                       });
                   }
                   status = 'indexed'; // Provisional, pending embedding
               } else {
                   // No chunks (empty file or all comments), but technically 'indexed'
                   status = 'indexed';
               }
           
               fileTasks.push({
                   file: fileMsg.file,
                   status,
                   reason,
                   hash,
                   mtimeMs,
                   size,
                   callData,
                   expectedChunks: chunkCount,
                   results: [] // Will store chunk results
               });
           } else {
               // status is skipped/error
               fileTasks.push({
                   file: fileMsg.file,
                   status,
                   reason,
                   hash,
                   mtimeMs,
                   size,
                   callData: null,
                   expectedChunks: 0,
                   results: []
               });
           }

        } catch (error) {
           fileTasks.push({
              file: fileMsg.file,
              status: 'error',
              error: error.message,
              expectedChunks: 0,
              results: []
           });
        }
      }

      // 2. Run Batched Inference on all accumulated chunks
      if (allPendingChunks.length > 0) {
          const embedder = await initializeEmbedder();
          const INFERENCE_BATCH_SIZE = 4;
          
          for (let i = 0; i < allPendingChunks.length; i += INFERENCE_BATCH_SIZE) {
             const batchSlice = allPendingChunks.slice(i, i + INFERENCE_BATCH_SIZE);
             const batchTexts = batchSlice.map(c => c.text);
             
             try {
                const output = await embedder(batchTexts, { pooling: 'mean', normalize: true });
                const hiddenSize = output.dims[output.dims.length - 1];
                
                for (let j = 0; j < batchSlice.length; j++) {
                   const start = j * hiddenSize;
                   const end = start + hiddenSize;
                   const vectorView = output.data.subarray(start, end);
                   const vector = new Float32Array(vectorView);
                   
                   batchSlice[j].vectorBuffer = vector.buffer;
                   batchTransfer.push(vector.buffer);
                }
                // Help GC by nullifying the large buffer reference (dispose() doesn't exist)
                try { output.data = null; } catch { /* frozen tensor */ }
             } catch (err) {
                 console.warn(`${workerLabel} Cross-file batch inference failed, retrying individually: ${err.message}`);
                 // Fallback: individual embedding for this failed batch
                 for (const item of batchSlice) {
                     try {
                        const output = await embedder(item.text, { pooling: 'mean', normalize: true });
                        const vector = new Float32Array(output.data);
                        // Help GC by nullifying the large buffer reference
                        try { output.data = null; } catch { /* frozen tensor */ }
                        item.vectorBuffer = vector.buffer;
                        batchTransfer.push(vector.buffer);
                     } catch (innerErr) {
                        console.warn(`${workerLabel} Chunk embedding failed: ${innerErr.message}`);
                     }
                 }
             }
             
             // Minimal yield to keep event loop breathing (optional, can be removed for max throughput)
             if (allPendingChunks.length > 50 && i % 50 === 0) {
                 await new Promise(resolve => setTimeout(resolve, 0));
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
                  vectorBuffer: chunkItem.vectorBuffer
              });
          }
      }
      
      // Validation pass: mark files as failed if they miss chunks
      for (const task of fileTasks) {
          if (task.status === 'indexed' && task.expectedChunks > 0) {
              if (task.results.length !== task.expectedChunks) {
                  task.status = 'error';
                  task.error = `Embedding incomplete: ${task.results.length}/${task.expectedChunks} chunks`;
              }
          }
      }

      // 4. Send response
      parentPort.postMessage({
        type: 'results',
        results: fileTasks,
        batchId,
        done: true
      }, batchTransfer);
      
      // Explicitly clear references and trigger GC
      batchTransfer.length = 0;
      if (global.gc) global.gc();
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
