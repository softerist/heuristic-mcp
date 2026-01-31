/**
 * Token estimation and limits for embedding models
 * 
 * Performance:
 * - O(1) model lookups with precomputed maps
 * - Zero regex / Zero allocations in hot loop
 * - Proper LRU cache eviction
 * - Optimized Unicode whitespace detection (ordered by probability)
 * - Eliminated double toLowerCase() calls
 * - Type-safe guard rails on all public APIs
 * - Branchless special character counting
 */

const IS_TEST_ENV = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

const MODEL_TOKEN_LIMITS_RAW = {
  // NOTE: While jina-embeddings-v2-base-code supports 8192 tokens, ONNX runtime
  // allocates O(n²) memory for attention. Using 512 tokens for optimal speed
  // with 4 ONNX threads (~1.5GB RAM, fastest inference).
  'jinaai/jina-embeddings-v2-base-code': 512,
    default: 512, // Safe default for BERT-like models
  };
  
  export const MODEL_TOKEN_LIMITS = IS_TEST_ENV
    ? { ...MODEL_TOKEN_LIMITS_RAW }
    : Object.freeze({ ...MODEL_TOKEN_LIMITS_RAW });
  
  const DEFAULT_LIMIT = MODEL_TOKEN_LIMITS.default ?? 512;
  
  /**
   * Precomputed case-insensitive lookup
   */
  const MODEL_LIMITS_LC = new Map();
  for (const [k, v] of Object.entries(MODEL_TOKEN_LIMITS)) {
    MODEL_LIMITS_LC.set(k.toLowerCase(), v);
  }
  
  /**
   * Internal helper: get model limit from pre-normalized key
   * Avoids double toLowerCase() when called from cache flow
   * @param {string} lowerName - Pre-normalized lowercase model name
   * @param {*} originalName - Original model name (may not be a string)
   * @returns {number} Token limit
   */
  function getModelTokenLimitFromLower(lowerName, originalName) {
    // Fast path: try exact match first (only if original is a string)
    if (typeof originalName === 'string') {
      const direct = MODEL_TOKEN_LIMITS[originalName];
      if (direct !== undefined) return direct;
    }
  
    // Slow path: use pre-normalized key
    const exact = MODEL_LIMITS_LC.get(lowerName);
    if (exact !== undefined) return exact;
  
    // Heuristics for common models (use conservative limits for ONNX speed)
    // 512 tokens = fastest, 1024 = 4x more compute due to O(n²) attention
    if (lowerName.includes('jina') || lowerName.includes('nomic') || lowerName.includes('gte-large')) {
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
  
  /**
   * Get the maximum token limit for a given model
   * @param {string} modelName - The model name
   * @returns {number} Maximum tokens supported by the model
   */
  export function getModelTokenLimit(modelName) {
    // Guard clause for non-string or empty inputs
    if (typeof modelName !== 'string' || modelName.length === 0) return DEFAULT_LIMIT;
  
    const direct = MODEL_TOKEN_LIMITS[modelName];
    if (direct !== undefined) return direct;
  
    const lower = modelName.toLowerCase();
    return getModelTokenLimitFromLower(lower, modelName);
  }
/**
 * LRU cache for chunking parameters
 * @type {Map<string, {maxTokens: number, targetTokens: number, overlapTokens: number}>}
 */
const MAX_CACHE_SIZE = 100;
const chunkingParamsCache = new Map();

/**
 * Get chunking parameters for a model
 * @param {string} modelName - The model name
 * @returns {{maxTokens: number, targetTokens: number, overlapTokens: number}}
 */
export function getChunkingParams(modelName) {
  const key = (typeof modelName === 'string' && modelName.length) 
    ? modelName.toLowerCase() 
    : '';
  
  // Fast path for invalid inputs: don't consume cache slots
  if (key === '') {
    const maxTokens = DEFAULT_LIMIT;
    const targetTokens = Math.trunc(maxTokens * 0.85);
    const overlapTokens = Math.trunc(targetTokens * 0.18);
    return { maxTokens, targetTokens, overlapTokens };
  }
  
  // LRU: If hit, delete and re-insert to mark as most recently used
  const cached = chunkingParamsCache.get(key);
  if (cached) {
    chunkingParamsCache.delete(key);
    chunkingParamsCache.set(key, cached);
    return cached;
  }

  // Cache miss: compute new params (avoid double toLowerCase)
  const maxTokens = getModelTokenLimitFromLower(key, modelName);
  const targetTokens = Math.trunc(maxTokens * 0.85);
  const overlapTokens = Math.trunc(targetTokens * 0.18);
  
  const params = { maxTokens, targetTokens, overlapTokens };

  // LRU eviction: remove oldest entry if at capacity
  if (chunkingParamsCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = chunkingParamsCache.keys().next().value;
    chunkingParamsCache.delete(oldestKey);
  }

  chunkingParamsCache.set(key, params);
  return params;
}

/**
 * ASCII whitespace lookup table
 */
const WS = new Uint8Array(128);
WS[9]  = 1; // \t (horizontal tab)
WS[10] = 1; // \n (line feed)
WS[11] = 1; // \v (vertical tab)
WS[12] = 1; // \f (form feed)
WS[13] = 1; // \r (carriage return)
WS[32] = 1; // space

/**
 * ASCII special character lookup table
 */
const SPECIAL = new Uint8Array(128);
const SPECIAL_CHARS = '{}()[];:,.<>!=+-*/%&|^~@#$"\'`\\';
for (let i = 0; i < SPECIAL_CHARS.length; i++) {
  SPECIAL[SPECIAL_CHARS.charCodeAt(i)] = 1;
}

/**
 * Calculate token count for a word of given length
 * This function will be inlined by V8
 * @param {number} len - Word length in characters
 * @returns {number} Estimated token count
 */
function calcWordTokens(len) {
  if (len <= 4) return 1;
  if (len <= 10) return 2;
  return (len + 3) >> 2; // ceil(len / 4)
}

/**
 * Estimate token count for text (conservative estimate for code)
 * 
 * Performance optimizations:
 * - No regex (pure integer comparisons)
 * - No string allocations (charCodeAt only)
 * - Inlined word token calculation
 * - Unicode checks ordered by frequency
 * - Branchless special character counting
 * 
 * @param {string} text - The text to estimate tokens for
 * @returns {number} Estimated token count
 */
export function estimateTokens(text) {
  // Type-safe guard: prevents crashes from non-string inputs
  if (typeof text !== 'string' || text.length === 0) return 0;

  const len = text.length;
  let tokenCount = 2; // [CLS] + [SEP]
  let specialCount = 0;
  let wordStart = -1;

  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    
    // ASCII fast path (most common for code)
    if (code < 128) {
      if (WS[code]) {
        if (wordStart !== -1) {
          tokenCount += calcWordTokens(i - wordStart);
          wordStart = -1;
        }
      } else {
        // Branchless: add 0 or 1 based on SPECIAL[code]
        specialCount += SPECIAL[code];
        if (wordStart === -1) wordStart = i;
      }
      continue;
    }

    // Unicode whitespace: ordered by frequency for real-world text
    // Note: Includes legacy 0x180E for tokenization compatibility even though
    // modern JS \s doesn't consider it whitespace (ES2016+)
    const isUnicodeWS = 
      code === 0x00a0 ||                        // NBSP (most common)
      code === 0x202f ||                        // NARROW NO-BREAK SPACE
      (code >= 0x2000 && code <= 0x200a) ||     // EN QUAD..HAIR SPACE
      code === 0x3000 ||                        // IDEOGRAPHIC SPACE (CJK)
      code === 0x2028 ||                        // LINE SEPARATOR
      code === 0x2029 ||                        // PARAGRAPH SEPARATOR
      code === 0x205f ||                        // MEDIUM MATHEMATICAL SPACE
      code === 0x1680 ||                        // OGHAM SPACE MARK
      code === 0x180e ||                        // MONGOLIAN VOWEL SEPARATOR (legacy)
      code === 0x0085 ||                        // NEXT LINE (NEL)
      code === 0xfeff;                          // ZERO WIDTH NO-BREAK SPACE / BOM

    if (isUnicodeWS) {
      if (wordStart !== -1) {
        tokenCount += calcWordTokens(i - wordStart);
        wordStart = -1;
      }
    } else {
      // Non-ASCII, non-whitespace (e.g., CJK, emojis, accented chars)
      // Conservative estimate: treat each as 1 token
      if (wordStart !== -1) {
        tokenCount += calcWordTokens(i - wordStart);
        wordStart = -1;
      }
      tokenCount++;
    }
  }

  // Flush final word
  if (wordStart !== -1) {
    tokenCount += calcWordTokens(len - wordStart);
  }

  // Add ~50% of special chars as tokens
  tokenCount += specialCount >> 1;

  return tokenCount;
}
