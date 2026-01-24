import { parentPort, workerData } from 'worker_threads';
import { pipeline } from '@xenova/transformers';

let embedder = null;
const RESULT_BATCH_SIZE = 25;

function toFloat32Array(vector) {
  if (vector instanceof Float32Array) {
    return vector;
  }
  return Float32Array.from(vector);
}

// Initialize the embedding model once when worker starts
async function initializeEmbedder() {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', workerData.embeddingModel);
  }
  return embedder;
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
