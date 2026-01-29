import { loadConfig } from '../lib/config.js';
import { CodebaseIndexer } from '../features/index-codebase.js';
import os from 'os';
import assert from 'assert';

async function verify() {
  console.log('--- Verifying Fixes ---');

  // 1. Verify Config: embeddingProcessPerBatch default
  console.log('1. Checking config defaults...');
  const config = await loadConfig(); // should load default from code + local config.json if present
  // Reset config to defaults to test our code changes purely (mocking what we can)
  // Actually loadConfig merges with defaults, so we check the resulting object.
  // We expect embeddingProcessPerBatch to be FALSE by default now, unless config.json overrides it.
  // To be safe, we will inspect the DEFAULT_CONFIG export if possible, but loadConfig returns the resolved one.
  
  if (config.embeddingProcessPerBatch === false) {
     console.log('✅ embeddingProcessPerBatch is false by default (or as configured)');
  } else {
     console.log('⚠️ embeddingProcessPerBatch is true - check if config.json overrides it');
  }

  // 2. Verify Config: workerThreads 'auto' resolution
  // We need to simulate 'auto' if it's already resolved. 
  // loadConfig modifies the config object in place.
  console.log(`   Resolved workerThreads: ${config.workerThreads}`);
  
  if (config.workerThreads !== 'auto' && typeof config.workerThreads === 'number') {
      const cpus = os.cpus().length;
      const expected = Math.max(1, Math.min(2, cpus - 1));
      if (config.workerThreads <= 2 && config.workerThreads >= 1) {
          console.log(`✅ workerThreads resolved correctly to ${config.workerThreads} (System CPUs: ${cpus})`);
      } else {
          console.error(`❌ workerThreads resolution suspicious: ${config.workerThreads}`);
      }
  }

  // 3. Verify CodebaseIndexer uses workers
  console.log('2. Checking CodebaseIndexer worker logic...');
  const mockConfig = { 
      workerThreads: 2, 
      embeddingProcessPerBatch: false,
      excludePatterns: [] 
  };
  const indexer = new CodebaseIndexer({}, {}, mockConfig);
  
  const useWorkers = indexer.shouldUseWorkers();
  if (useWorkers) {
      console.log('✅ shouldUseWorkers() is TRUE when embeddingProcessPerBatch is false');
  } else {
      console.error('❌ shouldUseWorkers() should be TRUE');
  }

  // 4. Verify CodebaseIndexer DOES NOT use workers if embeddingProcessPerBatch is true
  console.log('3. Checking CodebaseIndexer conflict resolution...');
  const mockConfigConflict = { 
    workerThreads: 2, 
    embeddingProcessPerBatch: true,
    excludePatterns: [] 
  };
  const indexerConflict = new CodebaseIndexer({}, {}, mockConfigConflict);
  
  const useWorkersConflict = indexerConflict.shouldUseWorkers();
  if (!useWorkersConflict) {
      console.log('✅ shouldUseWorkers() is FALSE when embeddingProcessPerBatch is true');
  } else {
      console.error('❌ shouldUseWorkers() should be FALSE to prevent double resource usage');
  }

  console.log('--- Verification Complete ---');
}

verify().catch(console.error);
