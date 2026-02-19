import { embedQueryInChildProcess } from './lib/embed-query-process.js';
import process from 'process';

// Mock config
const config = {
  embeddingModel: 'jinaai/jina-embeddings-v2-base-code',
  embeddingProcessNumThreads: 4,
  embeddingPoolIdleTimeoutMs: 2000,
  verbose: true,
};

console.log('PID:', process.pid);

process.on('exit', (code) => {
  console.log('[DEBUG] Process event: exit with code:', code);
});

process.on('beforeExit', (code) => {
  console.log('[DEBUG] Process event: beforeExit (natural exit) with code:', code);
});

console.log('Starting reproduction script...');
console.log('1. Performing first embedding...');

try {
  const result = await embedQueryInChildProcess('test query', config);
  console.log('1. Result received (length):', result.length);
} catch (err) {
  console.error('1. Failed:', err);
}

console.log('2. Waiting for idle timeout (3000ms)...');

// We use a timeout that is LONGER than the 2000ms idle timeout
setTimeout(() => {
  console.log('3. Main timeout reached (3000ms). Process should be alive.');
}, 3000);

// Ensure this timer keeps the process alive
// t.ref() is default

console.log('Timer set.');
