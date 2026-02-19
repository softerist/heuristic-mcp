

const IS_TEST_ENV = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

const MODEL_TOKEN_LIMITS_RAW = {
  
  
  
  'jinaai/jina-embeddings-v2-base-code': 512,
  default: 512, 
};

export const MODEL_TOKEN_LIMITS = IS_TEST_ENV
  ? { ...MODEL_TOKEN_LIMITS_RAW }
  : Object.freeze({ ...MODEL_TOKEN_LIMITS_RAW });

const DEFAULT_LIMIT = MODEL_TOKEN_LIMITS.default ?? 512;


const MODEL_LIMITS_LC = new Map();
for (const [k, v] of Object.entries(MODEL_TOKEN_LIMITS)) {
  MODEL_LIMITS_LC.set(k.toLowerCase(), v);
}


function getModelTokenLimitFromLower(lowerName, originalName) {
  
  if (typeof originalName === 'string') {
    const direct = MODEL_TOKEN_LIMITS[originalName];
    if (direct !== undefined) return direct;
  }

  
  const exact = MODEL_LIMITS_LC.get(lowerName);
  if (exact !== undefined) return exact;

  
  
  if (
    lowerName.includes('jina') ||
    lowerName.includes('nomic') ||
    lowerName.includes('gte-large')
  ) {
    return 512;
  }
  if (lowerName.includes('gte-base') || lowerName.includes('gte-small')) {
    return 512;
  }
  if (lowerName.includes('minilm')) {
    return 512;
  }

  return DEFAULT_LIMIT;
}


export function getModelTokenLimit(modelName) {
  
  if (typeof modelName !== 'string' || modelName.length === 0) return DEFAULT_LIMIT;

  const direct = MODEL_TOKEN_LIMITS[modelName];
  if (direct !== undefined) return direct;

  const lower = modelName.toLowerCase();
  return getModelTokenLimitFromLower(lower, modelName);
}

import { CHUNKING_PARAMS_CACHE_SIZE as MAX_CACHE_SIZE } from './constants.js';
const chunkingParamsCache = new Map();


export function getChunkingParams(modelName) {
  const key = typeof modelName === 'string' && modelName.length ? modelName.toLowerCase() : '';

  
  if (key === '') {
    const maxTokens = DEFAULT_LIMIT;
    const targetTokens = Math.trunc(maxTokens * 0.85);
    const overlapTokens = Math.trunc(targetTokens * 0.18);
    return { maxTokens, targetTokens, overlapTokens };
  }

  
  
  
  
  const cached = chunkingParamsCache.get(key);
  if (cached) {
    chunkingParamsCache.delete(key);
    chunkingParamsCache.set(key, cached);
    return cached;
  }

  
  const maxTokens = getModelTokenLimitFromLower(key, modelName);
  const targetTokens = Math.trunc(maxTokens * 0.85);
  const overlapTokens = Math.trunc(targetTokens * 0.18);

  const params = { maxTokens, targetTokens, overlapTokens };

  
  if (chunkingParamsCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = chunkingParamsCache.keys().next().value;
    chunkingParamsCache.delete(oldestKey);
  }

  chunkingParamsCache.set(key, params);
  return params;
}


const WS = new Uint8Array(128);
WS[9] = 1; 
WS[10] = 1; 
WS[11] = 1; 
WS[12] = 1; 
WS[13] = 1; 
WS[32] = 1; 


const SPECIAL = new Uint8Array(128);
const SPECIAL_CHARS = '{}()[];:,.<>!=+-*/%&|^~@#$"\'`\\';
for (let i = 0; i < SPECIAL_CHARS.length; i++) {
  SPECIAL[SPECIAL_CHARS.charCodeAt(i)] = 1;
}


function calcWordTokens(len) {
  if (len <= 4) return 1;
  if (len <= 10) return 2;
  return (len + 3) >> 2; 
}


export function estimateTokens(text, { includeSpecialTokens = true } = {}) {
  
  if (typeof text !== 'string' || text.length === 0) return 0;

  const len = text.length;
  let tokenCount = includeSpecialTokens ? 2 : 0; 
  let specialCount = 0;
  let wordStart = -1;

  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);

    
    if (code < 128) {
      if (WS[code]) {
        if (wordStart !== -1) {
          tokenCount += calcWordTokens(i - wordStart);
          wordStart = -1;
        }
      } else {
        
        specialCount += SPECIAL[code];
        if (wordStart === -1) wordStart = i;
      }
      continue;
    }

    
    
    
    const isUnicodeWS =
      code === 0x00a0 || 
      code === 0x202f || 
      (code >= 0x2000 && code <= 0x200a) || 
      code === 0x3000 || 
      code === 0x2028 || 
      code === 0x2029 || 
      code === 0x205f || 
      code === 0x1680 || 
      code === 0x180e || 
      code === 0x0085 || 
      code === 0xfeff; 

    if (isUnicodeWS) {
      if (wordStart !== -1) {
        tokenCount += calcWordTokens(i - wordStart);
        wordStart = -1;
      }
    } else {
      
      
      if (wordStart !== -1) {
        tokenCount += calcWordTokens(i - wordStart);
        wordStart = -1;
      }
      tokenCount++;
    }
  }

  
  if (wordStart !== -1) {
    tokenCount += calcWordTokens(len - wordStart);
  }

  
  tokenCount += specialCount >> 1;

  return tokenCount;
}
