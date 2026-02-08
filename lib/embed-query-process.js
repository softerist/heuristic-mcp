import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMBEDDING_PROCESS_PATH = path.join(__dirname, 'embedding-process.js');

// Persistent child process pool - single instance
let persistentChild = null;
let childReadline = null;
let idleTimer = null;
let currentConfig = null;
let pendingRequests = [];
let isProcessingRequest = false;

// Default idle timeout: 30 seconds - child exits after this to free memory
const DEFAULT_IDLE_TIMEOUT_MS = 30000;

/**
 * Get or create the persistent embedding child process.
 * The child stays alive for consecutive queries, then exits after idle timeout.
 */
function getOrCreateChild(config) {
  if (persistentChild && !persistentChild.killed) {
    // Reset idle timer on each use
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

  // Set up readline for line-by-line response parsing
  childReadline = readline.createInterface({
    input: persistentChild.stdout,
    crlfDelay: Infinity,
  });

  childReadline.on('line', (line) => {
    if (!line.trim()) return;
    
    // Process the response for the current pending request
    if (pendingRequests.length > 0) {
      const { resolve, reject, startTime } = pendingRequests.shift();
      try {
        const result = JSON.parse(line);
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
    }
  });

  persistentChild.stderr.on('data', (data) => {
    if (currentConfig?.verbose) {
      process.stderr.write(data);
    }
  });

  persistentChild.on('error', (err) => {
    console.error(`[EmbedPool] Child process error: ${err.message}`);
    cleanupChild();
    // Reject all pending requests
    for (const { reject } of pendingRequests) {
      reject(new Error(`Child process error: ${err.message}`));
    }
    pendingRequests = [];
  });

  persistentChild.on('close', (code) => {
    if (currentConfig?.verbose) {
      console.info(`[EmbedPool] Child process exited with code ${code}`);
    }
    cleanupChild();
    // Reject remaining pending requests so they can retry
    for (const { reject } of pendingRequests) {
      reject(new Error(`Child process exited unexpectedly with code ${code}`));
    }
    pendingRequests = [];
  });

  resetIdleTimer(config);
  
  if (config.verbose) {
    console.info(`[EmbedPool] Started persistent embedding child process (PID: ${persistentChild.pid})`);
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
        console.info(`[EmbedPool] Idle timeout reached, shutting down child process to free memory`);
      }
      shutdownChild();
    }
  }, timeout);
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
  if (persistentChild && !persistentChild.killed) {
    try {
      // Send shutdown command
      persistentChild.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n');
    } catch {
      // If write fails, force kill
      persistentChild.kill();
    }
  }
  cleanupChild();
}

function processNextRequest() {
  if (isProcessingRequest || pendingRequests.length === 0) return;
  
  const request = pendingRequests[0];
  if (!request) return;
  
  isProcessingRequest = true;
  
  try {
    const child = getOrCreateChild(request.config);
    child.stdin.write(JSON.stringify(request.payload) + '\n');
  } catch (err) {
    const { reject } = pendingRequests.shift();
    reject(err);
    isProcessingRequest = false;
    processNextRequest();
  }
}

/**
 * Embed a single query string using a persistent child process.
 * The child process stays alive for consecutive queries, then exits after idle timeout.
 * This gives fast consecutive searches + memory cleanup after idle period.
 * 
 * @param {string} query - The query text to embed
 * @param {object} config - Configuration object with embeddingModel and embeddingProcessNumThreads
 * @returns {Promise<Float32Array>} - The embedding vector
 */
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

/**
 * Force shutdown the persistent child process to immediately free memory.
 * Called when user explicitly wants to free memory.
 */
export function forceShutdownEmbeddingPool() {
  shutdownChild();
}

/**
 * Check if the persistent child process is currently running.
 */
export function isEmbeddingPoolActive() {
  return persistentChild !== null && !persistentChild.killed;
}
