import { pipeline } from '@huggingface/transformers';
import { configureNativeOnnxBackend } from './onnx-backend.js';
import readline from 'readline';

// Always log to stderr for debugging (goes to parent's stderr)
const log = (...args) => {
  // Always log for now to verify fix - can be gated by EMBEDDING_PROCESS_VERBOSE later
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
    label: `[Child:${process.pid}]`,
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
    log(`[Child:${process.pid}] Loading model ${embeddingModel}...`);
    const loadStart = Date.now();
    embedderPromise = pipeline('feature-extraction', embeddingModel, {
      quantized: true,
    }).then((model) => {
      const loadSec = ((Date.now() - loadStart) / 1000).toFixed(1);
      log(`[Child:${process.pid}] Model ready in ${loadSec}s, ${formatMemory()}`);
      return model;
    });
  } else if (configuredModel && embeddingModel !== configuredModel) {
    log(`[Child:${process.pid}] Warning: embeddingModel changed (${configuredModel} -> ${embeddingModel})`);
  } else if (configuredThreads !== null && numThreads !== configuredThreads) {
    log(`[Child:${process.pid}] Warning: numThreads changed (${configuredThreads} -> ${numThreads})`);
  }

  return embedderPromise;
}

async function runEmbedding(payload) {
  const {
    embeddingModel,
    chunks = [],
    numThreads = 1,
    requestId = null,
  } = payload || {};

  if (!embeddingModel) {
    throw new Error('Missing embeddingModel');
  }

  const reqId = requestId ?? requestCounter++;
  const embedder = await getEmbedder(embeddingModel, numThreads);
  log(`[Child:${process.pid}] Request ${reqId}: embedding ${chunks.length} chunks, ${formatMemory()}`);

  const results = [];
  let disposeCount = 0;
  const start = Date.now();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkStart = Date.now();
    try {
      const output = await embedder(chunk.text, { pooling: 'mean', normalize: true });
      // CRITICAL: Deep copy the data BEFORE releasing references
      const vector = new Float32Array(output.data);

      // Aggressive memory cleanup - transformers.js tensors don't have dispose()
      // but we can help GC by nullifying large buffers
      if (output.data) {
        try {
          // Try to null out the internal buffer reference
          output.data = null;
        } catch {
          // Some tensors may be frozen
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

      // Trigger GC every 5 chunks if available (requires --expose-gc)
      if ((i + 1) % 5 === 0) {
        if (typeof global.gc === 'function') {
          global.gc();
        }
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        log(`[Child:${process.pid}] Request ${reqId}: processed ${i + 1}/${chunks.length} chunks in ${elapsed}s, ${formatMemory()}`);
      } else if (chunks.length <= 3) {
        const chunkMs = Date.now() - chunkStart;
        log(`[Child:${process.pid}] Request ${reqId}: chunk ${i + 1}/${chunks.length} ${chunkMs}ms`);
      }
    } catch (error) {
      results.push({
        file: chunk.file,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        error: error.message,
        success: false,
      });
    }
  }

  const totalSec = ((Date.now() - start) / 1000).toFixed(1);
  log(`[Child:${process.pid}] Request ${reqId}: done ${results.length} chunks in ${totalSec}s, ${disposeCount} tensors disposed, ${formatMemory()}`);
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
