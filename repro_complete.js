import { embedQueryInChildProcess } from './lib/embed-query-process.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import process from 'process';

// Mock config
const config = {
  embeddingModel: 'jinaai/jina-embeddings-v2-base-code',
  embeddingProcessNumThreads: 4,
  embeddingPoolIdleTimeoutMs: 600000, // Safe timeout (fix)
  verbose: true,
};

console.log('PID:', process.pid);

process.on('exit', (code) => {
  console.log('[DEBUG] Process event: exit with code:', code);
});

process.on('uncaughtException', (err) => {
  console.log('[DEBUG] Process event: uncaughtException:', err);
  process.exit(1);
});

async function main() {
  console.log('Starting repro with transport...');

  const transport = new StdioServerTransport();
  await transport.start();
  console.log('Transport started. Listening on stdin.');

  console.log('1. Performing first embedding...');
  await embedQueryInChildProcess('test query 1', config);
  console.log('1. Done.');

  console.log('2. Waiting for idle timeout (2000ms)...');
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log('3. Performing second embedding (should restart child)...');
  // This is where we expect the crash
  await embedQueryInChildProcess('test query 2', config);
  console.log('3. Done.');

  console.log('4. Closing transport...');
  await transport.close();
}

main().catch((err) => console.error('Main error:', err));
