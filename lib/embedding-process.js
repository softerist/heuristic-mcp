import { pipeline, env } from '@huggingface/transformers';
import { configureNativeOnnxBackend } from './onnx-backend.js';
import {
  EMBEDDING_PROCESS_DEFAULT_GC_MAX_REQUESTS_WITHOUT_COLLECTION,
  EMBEDDING_PROCESS_DEFAULT_GC_MIN_INTERVAL_MS,
  EMBEDDING_PROCESS_DEFAULT_GC_RSS_THRESHOLD_MB,
  EMBEDDING_PROCESS_GC_STATE_INITIAL,
} from './constants.js';
import readline from 'readline';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';

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

const persistent = process.env.EMBEDDING_PROCESS_PERSISTENT === 'true';
let embedderPromise = null;
let configuredThreads = null;
let configuredModel = null;
let requestCounter = 0;
let gcSupported = typeof global.gc === 'function';
let nativeBackendConfigured = false;
const gcState = { ...EMBEDDING_PROCESS_GC_STATE_INITIAL };

function getGlobalCacheDir() {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches');
  }
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveGcPolicy(payload) {
  return {
    rssThresholdMb: toPositiveNumber(
      payload?.gcRssThresholdMb,
      EMBEDDING_PROCESS_DEFAULT_GC_RSS_THRESHOLD_MB
    ),
    minIntervalMs: toNonNegativeInteger(
      payload?.gcMinIntervalMs,
      EMBEDDING_PROCESS_DEFAULT_GC_MIN_INTERVAL_MS
    ),
    maxRequestsWithoutCollection: toPositiveInteger(
      payload?.gcMaxRequestsWithoutCollection,
      EMBEDDING_PROCESS_DEFAULT_GC_MAX_REQUESTS_WITHOUT_COLLECTION
    ),
  };
}

function maybeRunGc(policy, { reason = 'unknown', force = false } = {}) {
  if (!gcSupported) return false;

  const before = process.memoryUsage();
  const rssBeforeMb = before.rss / 1024 / 1024;
  const rssTrigger = rssBeforeMb >= policy.rssThresholdMb;
  const requestTrigger = gcState.requestsSinceLastRun >= policy.maxRequestsWithoutCollection;

  if (!force && !rssTrigger && !requestTrigger) {
    return false;
  }

  const now = Date.now();
  if (
    !force &&
    policy.minIntervalMs > 0 &&
    gcState.lastRunAtMs > 0 &&
    now - gcState.lastRunAtMs < policy.minIntervalMs
  ) {
    return false;
  }

  global.gc();
  const after = process.memoryUsage();
  gcState.lastRunAtMs = now;
  gcState.requestsSinceLastRun = 0;

  let trigger = 'forced';
  if (!force) {
    if (rssTrigger && requestTrigger) trigger = 'rss+requests';
    else if (rssTrigger) trigger = 'rss';
    else trigger = 'requests';
  }

  log(
    `[Child:${process.pid}] GC ${reason}: trigger=${trigger} rss ${(before.rss / 1024 / 1024).toFixed(1)}MB -> ${(after.rss / 1024 / 1024).toFixed(1)}MB`
  );
  return true;
}

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
    env.cacheDir = path.join(getGlobalCacheDir(), 'xenova');
    log(`Loading model ${embeddingModel}...`);
    const loadStart = Date.now();
    embedderPromise = pipeline('feature-extraction', embeddingModel, {
      quantized: true,
      dtype: 'fp32',
      session_options: {
        numThreads,
        intraOpNumThreads: numThreads,
        interOpNumThreads: 1,
      },
    }).then((model) => {
      const loadSec = ((Date.now() - loadStart) / 1000).toFixed(1);
      log(`Model ready in ${loadSec}s, ${formatMemory()}`);
      return model;
    });
  } else if (configuredModel && embeddingModel !== configuredModel) {
    log(`Model changed (${configuredModel} -> ${embeddingModel}); reloading embedder`);
    embedderPromise = null;
    configuredModel = null;
    return getEmbedder(embeddingModel, numThreads);
  } else if (configuredThreads !== null && numThreads !== configuredThreads) {
    log(`Warning: numThreads changed (${configuredThreads} -> ${numThreads})`);
  }

  return embedderPromise;
}

function resetEmbeddingProcessState() {
  embedderPromise = null;
  configuredThreads = null;
  configuredModel = null;
  requestCounter = 0;
  currentRequestId = -1;
  nativeBackendConfigured = false;
  gcState.lastRunAtMs = 0;
  gcState.requestsSinceLastRun = 0;
}

async function unloadModel() {
  if (!embedderPromise) {
    log('[Child] No model loaded, nothing to unload');
    return { success: true, wasLoaded: false };
  }

  try {
    const embedder = await embedderPromise;

    if (embedder && typeof embedder.dispose === 'function') {
      try {
        await embedder.dispose();
        log('[Child] Model disposed successfully');
      } catch (disposeErr) {
        log(`[Child] Model dispose warning: ${disposeErr.message}`);
      }
    }
  } catch (err) {
    log(`[Child] Error during model unload: ${err.message}`);
  }

  embedderPromise = null;
  configuredModel = null;
  configuredThreads = null;

  if (gcSupported) {
    maybeRunGc(resolveGcPolicy(), { reason: 'post-unload', force: true });
  }

  log(`[Child] Model unloaded, ${formatMemory()}`);
  return { success: true, wasLoaded: true };
}

async function runEmbedding(payload) {
  const {
    embeddingModel,
    chunks = [],
    numThreads = 1,
    batchSize = null,
    enableExplicitGc = true,
    gcRssThresholdMb = EMBEDDING_PROCESS_DEFAULT_GC_RSS_THRESHOLD_MB,
    gcMinIntervalMs = EMBEDDING_PROCESS_DEFAULT_GC_MIN_INTERVAL_MS,
    gcMaxRequestsWithoutCollection = EMBEDDING_PROCESS_DEFAULT_GC_MAX_REQUESTS_WITHOUT_COLLECTION,
    requestId = null,
  } = payload || {};
  const shouldRunGc = enableExplicitGc !== false && gcSupported;
  const gcPolicy = resolveGcPolicy({
    gcRssThresholdMb,
    gcMinIntervalMs,
    gcMaxRequestsWithoutCollection,
  });

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
  if (shouldRunGc) {
    gcState.requestsSinceLastRun += 1;
  }

  const BATCH_SIZE = Number.isInteger(batchSize) && batchSize > 0 ? Math.min(batchSize, 256) : 1;

  for (let batchStart = 0; batchStart < chunks.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, chunks.length);
    const batchChunks = chunks.slice(batchStart, batchEnd);
    const batchTexts = batchChunks.map((c) => c.text);

    try {
      const output = await embedder(batchTexts, { pooling: 'mean', normalize: true });

      const hiddenSize = output.dims[output.dims.length - 1];

      for (let j = 0; j < batchChunks.length; j++) {
        const chunk = batchChunks[j];
        const vecStart = j * hiddenSize;
        const vecEnd = vecStart + hiddenSize;

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

      if (typeof output.dispose === 'function') {
        try {
          output.dispose();
        } catch {}
      }
      disposeCount++;
    } catch (error) {
      log(`Batch failed, falling back to single: ${error.message}`);
      for (const chunk of batchChunks) {
        try {
          const output = await embedder(chunk.text, { pooling: 'mean', normalize: true });
          const vector = new Float32Array(output.data);
          if (typeof output.dispose === 'function') {
            try {
              output.dispose();
            } catch {}
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

    if (batchEnd % 20 === 0 || batchEnd === chunks.length) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      log(
        `[Child:${process.pid}] Request ${reqId}: processed ${batchEnd}/${chunks.length} chunks in ${elapsed}s, ${formatMemory()}`
      );
    }

    if (shouldRunGc && (batchEnd % 20 === 0 || batchEnd === chunks.length)) {
      maybeRunGc(gcPolicy, {
        reason: `request ${reqId} progress ${batchEnd}/${chunks.length}`,
      });
    }
  }

  const totalSec = ((Date.now() - start) / 1000).toFixed(1);
  log(
    `[Child:${process.pid}] Request ${reqId}: done ${results.length} chunks in ${totalSec}s, ${disposeCount} tensors disposed, ${formatMemory()}`
  );
  if (shouldRunGc) {
    maybeRunGc(gcPolicy, { reason: `request ${reqId} end` });
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

      if (payload?.type === 'unload') {
        chain = chain
          .then(() => unloadModel())
          .then((result) => {
            process.stdout.write(`${JSON.stringify(result)}\n`);
          })
          .catch((err) => {
            log(`[Child:${process.pid}] Error unloading model: ${err.message}`);
            process.stdout.write(`${JSON.stringify({ success: false, error: err.message })}\n`);
          });
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

function shouldRunMain() {
  if (process.env.EMBEDDING_PROCESS_RUN_MAIN === 'true') return true;
  if (process.env.VITEST) return false;
  if (!process.argv[1]) return false;
  const entryUrl = pathToFileURL(process.argv[1]).href;
  return import.meta.url === entryUrl;
}

if (shouldRunMain()) {
  main().catch((err) => {
    log(`[Child:${process.pid}] Error: ${err?.message || err}`);
    process.stderr.write(String(err?.message || err));
    process.exit(1);
  });
}

export { getEmbedder, resetEmbeddingProcessState, unloadModel };
