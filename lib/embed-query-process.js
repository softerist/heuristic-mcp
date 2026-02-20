import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { EMBEDDING_POOL_IDLE_TIMEOUT_MS } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMBEDDING_PROCESS_PATH = path.join(__dirname, 'embedding-process.js');

let persistentChild = null;
let childReadline = null;
let idleTimer = null;
let currentConfig = null;
let pendingRequests = [];
let isProcessingRequest = false;
let activeRequest = null;

const DEFAULT_IDLE_TIMEOUT_MS = EMBEDDING_POOL_IDLE_TIMEOUT_MS;

function getOrCreateChild(config) {
  if (persistentChild && !persistentChild.killed) {
    resetIdleTimer(config);
    return persistentChild;
  }

  const args = ['--expose-gc', EMBEDDING_PROCESS_PATH];
  persistentChild = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      EMBEDDING_PROCESS_PERSISTENT: 'true',
      EMBEDDING_PROCESS_RUN_MAIN: 'true',
      EMBEDDING_PROCESS_VERBOSE: config.verbose ? 'true' : '',
    },
  });

  currentConfig = config;

  childReadline = readline.createInterface({
    input: persistentChild.stdout,
    crlfDelay: Infinity,
  });

  childReadline.on('line', (line) => {
    if (!line.trim()) return;

    let result;
    try {
      result = JSON.parse(line);
    } catch {
      if (currentConfig?.verbose) {
        console.warn('[EmbedPool] Ignoring non-JSON stdout from embedding child');
      }
      return;
    }

    if (!result || typeof result !== 'object' || !Object.prototype.hasOwnProperty.call(result, 'results')) {
      if (currentConfig?.verbose) {
        console.warn('[EmbedPool] Ignoring unexpected stdout payload from embedding child');
      }
      return;
    }

    if (!activeRequest) {
      if (currentConfig?.verbose) {
        console.warn('[EmbedPool] Received embedding response with no active request');
      }
      return;
    }

    const { resolve, reject, startTime } = activeRequest;
    activeRequest = null;

    try {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

      if (!result.results || result.results.length === 0) {
        reject(new Error('Embedding child process returned no results'));
        return;
      }

      const embResult = result.results[0];
      if (!embResult.success) {
        reject(new Error(`Embedding failed: ${embResult.error}`));
        return;
      }

      const vector = new Float32Array(embResult.vector);

      if (currentConfig?.verbose) {
        console.info(`[Search] Query embedding (persistent child) completed in ${elapsed}s`);
      }

      resolve(vector);
    } catch (err) {
      reject(new Error(`Failed to parse embedding result: ${err.message}`));
    } finally {
      isProcessingRequest = false;
      processNextRequest();
    }
  });

  persistentChild.stderr.on('data', (data) => {
    if (currentConfig?.verbose) {
      process.stderr.write(data);
    }
  });

  persistentChild.on('error', (err) => {
    console.error(`[EmbedPool] Child process error: ${err.message}`);
    const inflight = activeRequest;
    cleanupChild();

    if (inflight) {
      inflight.reject(new Error(`Child process error: ${err.message}`));
      activeRequest = null;
    }

    for (const { reject } of pendingRequests) {
      reject(new Error(`Child process error: ${err.message}`));
    }
    pendingRequests = [];
  });

  persistentChild.on('close', (code) => {
    if (currentConfig?.verbose) {
      console.info(`[EmbedPool] Child process exited with code ${code}`);
    }
    const inflight = activeRequest;
    cleanupChild();

    if (inflight) {
      inflight.reject(new Error(`Child process exited unexpectedly with code ${code}`));
      activeRequest = null;
    }

    for (const { reject } of pendingRequests) {
      reject(new Error(`Child process exited unexpectedly with code ${code}`));
    }
    pendingRequests = [];
  });

  resetIdleTimer(config);

  if (config.verbose) {
    console.info(
      `[EmbedPool] Started persistent embedding child process (PID: ${persistentChild.pid})`
    );
  }

  return persistentChild;
}

function resetIdleTimer(config) {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }

  const timeout = config.embeddingPoolIdleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;

  idleTimer = setTimeout(() => {
    if (persistentChild && !persistentChild.killed) {
      if (currentConfig?.verbose) {
        console.info(
          `[EmbedPool] Idle timeout reached, shutting down child process to free memory`
        );
      }
      shutdownChild();
    }
  }, timeout);
  if (typeof idleTimer.unref === 'function') {
    idleTimer.unref();
  }
}

function cleanupChild() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (childReadline) {
    childReadline.close();
    childReadline = null;
  }
  persistentChild = null;
  isProcessingRequest = false;
}

function shutdownChild() {
  if (activeRequest) {
    activeRequest.reject(new Error('Embedding pool shutdown requested'));
    activeRequest = null;
  }
  for (const { reject } of pendingRequests) {
    reject(new Error('Embedding pool shutdown requested'));
  }
  pendingRequests = [];

  if (persistentChild && !persistentChild.killed) {
    try {
      persistentChild.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n');
    } catch {
      persistentChild.kill();
    }
  }
  cleanupChild();
}

function processNextRequest() {
  if (isProcessingRequest || activeRequest || pendingRequests.length === 0) return;

  const request = pendingRequests.shift();
  if (!request) return;

  isProcessingRequest = true;
  activeRequest = request;

  try {
    const child = getOrCreateChild(request.config);
    child.stdin.write(JSON.stringify(request.payload) + '\n');
  } catch (err) {
    const { reject } = request;
    reject(err);
    activeRequest = null;
    isProcessingRequest = false;
    processNextRequest();
  }
}

export async function embedQueryInChildProcess(query, config) {
  return new Promise((resolve, reject) => {
    const payload = {
      embeddingModel: config.embeddingModel,
      numThreads: config.embeddingProcessNumThreads || 4,
      chunks: [{ file: '__query__', startLine: 0, endLine: 0, text: query }],
    };

    pendingRequests.push({
      payload,
      config,
      resolve,
      reject,
      startTime: Date.now(),
    });

    processNextRequest();
  });
}

export function forceShutdownEmbeddingPool() {
  shutdownChild();
}

export function isEmbeddingPoolActive() {
  return persistentChild !== null && !persistentChild.killed;
}
