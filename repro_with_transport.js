import { embedQueryInChildProcess } from './lib/embed-query-process.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

async function main() {
  console.log('Starting repro with transport...');

  // Start transport to keep process alive via stdin
  const transport = new StdioServerTransport();
  await transport.start();
  console.log('Transport started. Listening on stdin.');

  console.log('1. Performing first embedding...');
  try {
    const result = await embedQueryInChildProcess('test query', config);
    console.log('1. Result received (length):', result.length);
  } catch (err) {
    console.error('1. Failed:', err);
  }

  console.log('2. Waiting for idle timeout (3000ms)...');

  // We do NOT use a long timeout here. We rely on transport to keep us alive.
  // We use a shorter timeout just to print status
  setTimeout(() => {
    console.log('3. Timer fired (3000ms). Checking if we are still alive.');
  }, 3000);
}

main().catch((err) => console.error('Main error:', err));
