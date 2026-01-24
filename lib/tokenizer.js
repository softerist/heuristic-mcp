/**
 * Token estimation and limits for embedding models
 *
 * This module provides token counting utilities and model-specific limits
 * to ensure text chunks don't exceed the model's maximum sequence length.
 */

/**
 * Token limits for supported embedding models
 * Each model has its own maximum sequence length
 */
export const MODEL_TOKEN_LIMITS = {
  // Jina models (8k context)
  'jinaai/jina-embeddings-v2-base-code': 8192,

  // Default fallback
  default: 8192,
};

/**
 * Get the maximum token limit for a given model
 * Case-insensitive lookup for robustness
 * @param {string} modelName - The model name (e.g., "Xenova/all-MiniLM-L6-v2")
 * @returns {number} Maximum tokens supported by the model
 */
export function getModelTokenLimit(modelName) {
  if (!modelName) return MODEL_TOKEN_LIMITS['default'];

  // Direct match first (fastest)
  if (MODEL_TOKEN_LIMITS[modelName] !== undefined) {
    return MODEL_TOKEN_LIMITS[modelName];
  }

  // Case-insensitive search
  const normalizedName = modelName.toLowerCase();
  for (const [key, value] of Object.entries(MODEL_TOKEN_LIMITS)) {
    if (key.toLowerCase() === normalizedName) {
      return value;
    }
  }

  return MODEL_TOKEN_LIMITS['default'];
}

/**
 * Get chunking parameters for a model
 * Returns target and overlap tokens based on the model's limit
 * @param {string} modelName - The model name
 * @returns {{ maxTokens: number, targetTokens: number, overlapTokens: number }}
 */
export function getChunkingParams(modelName) {
  const maxTokens = getModelTokenLimit(modelName);

  // Cap max tokens for chunking to 2048 to prevent memory explosion
  // even if model supports 8k. 8k contexts require massive RAM.
  const SAFE_MAX_TOKENS = 2048;
  const effectiveMax = Math.min(maxTokens, SAFE_MAX_TOKENS);

  // Target: 85% of effective max to leave safety buffer
  const targetTokens = Math.floor(effectiveMax * 0.85);

  // Overlap: 15-20% of target but CAP at 100 tokens to avoid massive duplication
  // with large chunk sizes (Jina).
  const overlapTokens = Math.min(100, Math.floor(targetTokens * 0.18));

  return {
    maxTokens,
    targetTokens,
    overlapTokens,
  };
}

/**
 * Estimate token count for text (conservative estimate for code)
 * Uses a simple heuristic: counts words, special characters, and estimates subwords
 *
 * This is conservative - actual tokenizers may produce fewer tokens.
 * For most accurate results, use the actual tokenizer, but this is much faster.
 *
 * @param {string} text - The text to estimate tokens for
 * @returns {number} Estimated token count
 */
export function estimateTokens(text) {
  if (!text || text.length === 0) return 0;

  // Count words (split by whitespace)
  const words = text.split(/\s+/).filter((w) => w.length > 0);

  // Count special characters/punctuation that often become separate tokens
  const specialChars = (text.match(/[{}()[\];:,.<>!=+\-*/%&|^~@#$"'`\\]/g) || []).length;

  // Estimate: words + special chars + 2 (for [CLS] and [SEP] special tokens)
  // For long words, add extra tokens due to subword tokenization
  let tokenCount = 2; // [CLS] and [SEP]

  for (const word of words) {
    if (word.length <= 4) {
      tokenCount += 1;
    } else if (word.length <= 10) {
      tokenCount += 2;
    } else {
      // Long words get split into ~4-char subwords
      tokenCount += Math.ceil(word.length / 4);
    }
  }

  // Many special chars merge with adjacent tokens, so count ~50%
  tokenCount += Math.floor(specialChars * 0.5);

  return tokenCount;
}

/**
 * Check if text exceeds the token limit for a model
 * @param {string} text - The text to check
 * @param {string} modelName - The model name
 * @returns {boolean} True if the text exceeds the limit
 */
export function exceedsTokenLimit(text, modelName) {
  const limit = getModelTokenLimit(modelName);
  const tokens = estimateTokens(text);
  return tokens > limit;
}
