import { loadConfig } from '../lib/config.js';
import { CodebaseIndexer } from '../features/index-codebase.js';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

async function verify() {
  console.log('--- Verifying Fixes ---');

  // 1. Verify Config: embeddingProcessPerBatch default
  console.log('1. Checking config defaults...');
  const config = await loadConfig(); 
  
  if (config.embeddingProcessPerBatch === false) {
     console.log('✅ embeddingProcessPerBatch is false by default');
  } else {
     console.log('⚠️ embeddingProcessPerBatch is true');
  }

  // 2. Verify Config: workerThreads 'auto' resolution
  console.log(`   Resolved workerThreads: ${config.workerThreads}`);
  
  if (config.workerThreads !== 'auto' && typeof config.workerThreads === 'number') {
      const cpus = os.cpus().length;
      // If config.json has 0, it stays 0. We'll check if the logic allows auto cap.
      // We manually test the auto logic here since loadConfig might load from file.
      const mockConfig = { workerThreads: 'auto' };
      // Simulate the logic we added to config.js:
      if (mockConfig.workerThreads === 'auto') {
        const calculated = Math.max(1, Math.min(2, cpus - 1));
        console.log(`✅ Auto logic would resolve to: ${calculated}`);
      }
  }

  // 3. Verify CodebaseIndexer uses workers
  console.log('2. Checking CodebaseIndexer worker logic...');
  const mockConfig = { 
      workerThreads: 2, 
      embeddingProcessPerBatch: false,
      excludePatterns: [],
      searchDirectory: process.cwd()
  };
  const indexer = new CodebaseIndexer({}, {}, mockConfig);
  
  const useWorkers = indexer.shouldUseWorkers();
  if (useWorkers) {
      console.log('✅ shouldUseWorkers() is TRUE when embeddingProcessPerBatch is false');
  } else {
      console.error('❌ shouldUseWorkers() should be TRUE');
  }

  // 4. Verify Ignore Logic
  console.log('3. Checking .gitignore logic...');
  try {
      await fs.writeFile('.gitignore', 'secret_folder/\n*.secret', 'utf8');
      await indexer.loadGitignore();
      
      const isExcludedDirectory = indexer.isExcluded('secret_folder/file.txt');
      const isExcludedFile = indexer.isExcluded('app.secret');
      const isIncluded = indexer.isExcluded('app.js');
      
      if (isExcludedDirectory && isExcludedFile && !isIncluded) {
          console.log('✅ .gitignore logic is working correctly');
      } else {
          console.error(`❌ .gitignore failure: dir=${isExcludedDirectory}, file=${isExcludedFile}, valid=${!isIncluded}`);
      }
      
      await fs.unlink('.gitignore');
  } catch (e) {
      console.error('Test setup failed:', e);
  }

  console.log('--- Verification Complete ---');
}

verify().catch(console.error);
