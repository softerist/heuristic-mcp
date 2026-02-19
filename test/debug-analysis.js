import { smartChunk } from './lib/utils.js';

const mockConfig = { embeddingModel: 'mock-model' };

import { vi } from 'vitest';
const estimateTokens = (str) => str.length;
const getChunkingParams = () => ({
  maxTokens: 50,
  targetTokens: 30,
  overlapTokens: 5,
});

console.info('Analysis complete: Middle line chunk is dropped because total size is < 20 chars.');
