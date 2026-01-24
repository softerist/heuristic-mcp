import { parentPort, workerData } from 'worker_threads';
import { pipeline, env } from '@xenova/transformers';

// Override console.log/warn to write to stderr so we don't break the MCP JSON-RPC protocol on stdout
console.log = (...args) => console.error(...args);
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
  console.log(...args);
};

function toFloat32Array(vector) {
  if (vector instanceof Float32Array) {
    return vector;
  }
  return Float32Array.from(vector);
}

// Initialize the embedding model once when worker starts
// Initialize the embedding model once when worker starts
// Use a promise to handle concurrent calls to initializeEmbedder safely
let embedderPromise = null;

async function initializeEmbedder() {
  if (!embedderPromise) {
    const modelLoadStart = Date.now();
    logInfo(`${workerLabel} Embedding model load started: ${workerData.embeddingModel}`);
    embedderPromise = pipeline('feature-extraction', workerData.embeddingModel)
      .then((model) => {
        const loadSeconds = ((Date.now() - modelLoadStart) / 1000).toFixed(1);
        logInfo(`${workerLabel} Embedding model ready: ${workerData.embeddingModel} (${loadSeconds}s)`);
        return model;
      });
  }
  return embedderPromise;
}

/**
 * Process chunks with optimized single-text embedding
 * Note: Batch processing with transformers.js WASM backend doesn't improve speed
 * because it loops internally. Single calls are actually faster.
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

// Listen for messages from main thread
parentPort.on('message', async (message) => {
  if (message.type === 'process') {
    try {
      await processChunks(message.chunks, message.batchId);
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        error: error.message,
        batchId: message.batchId,
      });
    }
  } else if (message.type === 'shutdown') {
    process.exit(0);
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
