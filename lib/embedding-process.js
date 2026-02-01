import { pipeline } from '@huggingface/transformers';
import { configureNativeOnnxBackend } from './onnx-backend.js';
import readline from 'readline';

// Always log to stderr for debugging (goes to parent's stderr)
let currentRequestId = -1;
const log = (...args) => {
  if (currentRequestId > 0 && !process.env.EMBEDDING_PROCESS_VERBOSE) {
    return;
  }
  console.error(...args);
};

function formatMemory() {
  const usage = process.memoryUsage();
  return `rss=${(usage.rss / 1024 / 1024).toFixed(1)}MB heap=${(usage.heapUsed / 1024 / 1024).toFixed(1)}MB`;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function toFloat32Array(vector) {
  if (vector instanceof Float32Array) return vector;
  return Float32Array.from(vector);
}

const persistent = process.env.EMBEDDING_PROCESS_PERSISTENT === 'true';
let embedderPromise = null;
let configuredThreads = null;
let configuredModel = null;
let requestCounter = 0;
let gcSupported = typeof global.gc === 'function';
let nativeBackendConfigured = false;

function ensureNativeBackend(threads) {
  if (nativeBackendConfigured && !threads) return;
  configureNativeOnnxBackend({
    log,
    label: '[Child]',
    threads,
  });
  nativeBackendConfigured = true;
}

function setThreads(numThreads) {
  ensureNativeBackend({
    intraOpNumThreads: numThreads,
    interOpNumThreads: 1,
  });
  configuredThreads = numThreads;
}

async function getEmbedder(embeddingModel, numThreads) {
  if (!embedderPromise) {
    configuredModel = embeddingModel;
    setThreads(numThreads);
    log(`Loading model ${embeddingModel}...`);
    const loadStart = Date.now();
    embedderPromise = pipeline('feature-extraction', embeddingModel, {
      quantized: true,
      dtype: 'fp32',
    }).then((model) => {
      const loadSec = ((Date.now() - loadStart) / 1000).toFixed(1);
      log(`Model ready in ${loadSec}s, ${formatMemory()}`);
      return model;
    });
  } else if (configuredModel && embeddingModel !== configuredModel) {
    log(`Warning: numThreads changed (${configuredThreads} -> ${numThreads})`);
  }

  return embedderPromise;
}

async function runEmbedding(payload) {
  const {
    embeddingModel,
    chunks = [],
    numThreads = 1,
    requestId = null,
    batchSize = null,
  } = payload || {};

  if (!embeddingModel) {
    throw new Error('Missing embeddingModel');
  }

  const reqId = requestId ?? requestCounter++;
  currentRequestId = reqId;
  const embedder = await getEmbedder(embeddingModel, numThreads);
  log(`Request ${reqId}: embedding ${chunks.length} chunks, ${formatMemory()}`);

  const results = [];
  let disposeCount = 0;
  const start = Date.now();

  // Batch embedding - tunable for throughput vs memory tradeoffs
  // FORCE BATCH_SIZE = 1 to restore 1.0 files/s speed (batching adds overhead on CPU)
  const BATCH_SIZE = 1;

  for (let batchStart = 0; batchStart < chunks.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, chunks.length);
    const batchChunks = chunks.slice(batchStart, batchEnd);
    const batchTexts = batchChunks.map((c) => c.text);

    try {
      // Process batch of texts in single inference call
      const output = await embedder(batchTexts, { pooling: 'mean', normalize: true });

      // Output shape: [batch_size, hidden_size]
      const hiddenSize = output.dims[output.dims.length - 1];

      for (let j = 0; j < batchChunks.length; j++) {
        const chunk = batchChunks[j];
        const vecStart = j * hiddenSize;
        const vecEnd = vecStart + hiddenSize;
        // Deep copy the slice before disposing
        const vector = new Float32Array(output.data.subarray(vecStart, vecEnd));

        results.push({
          file: chunk.file,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.text,
          vector: Array.from(vector),
          success: true,
        });
      }

      // Dispose tensor after extracting all vectors
      if (typeof output.dispose === 'function') {
        try {
          output.dispose();
        } catch {
          /* ignore */
        }
      }
      disposeCount++;
    } catch (error) {
      // Fallback: if batch fails, try one at a time
      log(`Batch failed, falling back to single: ${error.message}`);
      for (const chunk of batchChunks) {
        try {
          const output = await embedder(chunk.text, { pooling: 'mean', normalize: true });
          const vector = new Float32Array(output.data);
          if (typeof output.dispose === 'function') {
            try {
              output.dispose();
            } catch {
              /* ignore */
            }
          }
          disposeCount++;
          results.push({
            file: chunk.file,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content: chunk.text,
            vector: Array.from(vector),
            success: true,
          });
        } catch (innerErr) {
          results.push({
            file: chunk.file,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            error: innerErr.message,
            success: false,
          });
        }
      }
    }

    // Progress logging every 20 chunks
    if (batchEnd % 20 === 0 || batchEnd === chunks.length) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      log(
        `[Child:${process.pid}] Request ${reqId}: processed ${batchEnd}/${chunks.length} chunks in ${elapsed}s, ${formatMemory()}`
      );
    }

    // Trigger GC every 100 chunks to reduce overhead (was 40)
    if (batchEnd % 100 === 0 && typeof global.gc === 'function') {
      global.gc();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      log(
        `[Child:${process.pid}] Request ${reqId}: GC triggered after ${batchEnd}/${chunks.length} chunks in ${elapsed}s, ${formatMemory()}`
      );
    }
  }

  const totalSec = ((Date.now() - start) / 1000).toFixed(1);
  log(
    `[Child:${process.pid}] Request ${reqId}: done ${results.length} chunks in ${totalSec}s, ${disposeCount} tensors disposed, ${formatMemory()}`
  );
  if (gcSupported) {
    const before = process.memoryUsage();
    global.gc();
    const after = process.memoryUsage();
    log(
      `[Child:${process.pid}] Request ${reqId}: GC rss ${(before.rss / 1024 / 1024).toFixed(1)}MB -> ${(after.rss / 1024 / 1024).toFixed(1)}MB`
    );
  }
  const usage = process.memoryUsage();
  return {
    results,
    meta: {
      rssMb: usage.rss / 1024 / 1024,
      heapMb: usage.heapUsed / 1024 / 1024,
      heapTotalMb: usage.heapTotal / 1024 / 1024,
    },
  };
}

async function main() {
  log(`[Child:${process.pid}] Starting, ${formatMemory()}`);

  if (persistent) {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    let chain = Promise.resolve();

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch (err) {
        log(`[Child:${process.pid}] Failed to parse payload: ${err.message}`);
        process.stdout.write(`${JSON.stringify({ results: [] })}\n`);
        return;
      }

      if (payload?.type === 'shutdown') {
        rl.close();
        process.exit(0);
        return;
      }

      chain = chain
        .then(() => runEmbedding(payload))
        .then((output) => {
          process.stdout.write(`${JSON.stringify(output)}\n`);
        })
        .catch((err) => {
          log(`[Child:${process.pid}] Error processing payload: ${err.message}`);
          process.stdout.write(`${JSON.stringify({ results: [] })}\n`);
        });
    });
    return;
  }

  const raw = await readStdin();
  if (!raw) return;

  const payload = JSON.parse(raw);
  const output = await runEmbedding(payload);
  process.stdout.write(JSON.stringify(output));
}

main().catch((err) => {
  log(`[Child:${process.pid}] Error: ${err?.message || err}`);
  process.stderr.write(String(err?.message || err));
  process.exit(1);
});
