/**
 * Tests for Tokenizer utilities
 *
 * Tests the token estimation and model-specific limits including:
 * - Token estimation for various text types
 * - Model token limits lookup
 * - Chunking parameters calculation
 * - Token limit checking
 */

import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  getModelTokenLimit,
  getChunkingParams,
  exceedsTokenLimit,
  MODEL_TOKEN_LIMITS,
} from '../lib/tokenizer.js';

describe('Token Estimation', () => {
  describe('estimateTokens', () => {
    it('should return 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens(null)).toBe(0);
      expect(estimateTokens(undefined)).toBe(0);
    });

    it('should count simple words correctly', () => {
      // Simple words get ~1 token each + 2 for CLS/SEP
      const result = estimateTokens('hello world');
      expect(result).toBeGreaterThanOrEqual(4); // 2 words + 2 special tokens
      expect(result).toBeLessThanOrEqual(6);
    });

    it('should add extra tokens for long words', () => {
      const shortWord = estimateTokens('cat');
      const longWord = estimateTokens('internationalization');

      // Long words should have more tokens due to subword splitting
      expect(longWord).toBeGreaterThan(shortWord);
    });

    it('should count special characters', () => {
      const withoutSpecial = estimateTokens('hello world');
      const withSpecial = estimateTokens('hello(); world{}');

      // Special characters add to token count
      expect(withSpecial).toBeGreaterThan(withoutSpecial);
    });

    it('should handle code snippets', () => {
      const code = `
        function test() {
          const x = 10;
          return x * 2;
        }
      `;

      const tokens = estimateTokens(code);

      // Code has many special chars, should have reasonable token count
      expect(tokens).toBeGreaterThan(10);
      expect(tokens).toBeLessThan(100);
    });

    it('should handle multiline text', () => {
      const multiline = 'line one\nline two\nline three';
      const tokens = estimateTokens(multiline);

      expect(tokens).toBeGreaterThan(5);
    });
  });
});

describe('Model Token Limits', () => {
  describe('MODEL_TOKEN_LIMITS', () => {
    it('should have default limit', () => {
      expect(MODEL_TOKEN_LIMITS['default']).toBeDefined();
      expect(MODEL_TOKEN_LIMITS['default']).toBe(512);
    });

    it('should have limits for Jina models', () => {
      expect(MODEL_TOKEN_LIMITS['jinaai/jina-embeddings-v2-base-code']).toBe(8192);
    });
  });

  describe('getModelTokenLimit', () => {
    it('should return correct limit for known models', () => {
      expect(getModelTokenLimit('jinaai/jina-embeddings-v2-base-code')).toBe(8192);
    });

    it('should return default for unknown models', () => {
      expect(getModelTokenLimit('unknown/model-name')).toBe(512);
    });

    it('should return default for null/undefined', () => {
      expect(getModelTokenLimit(null)).toBe(512);
      expect(getModelTokenLimit(undefined)).toBe(512);
    });

    it('should be case-insensitive', () => {
      const normalCase = getModelTokenLimit('Xenova/all-MiniLM-L6-v2');
      const lowerCase = getModelTokenLimit('xenova/all-minilm-l6-v2');

      expect(lowerCase).toBe(normalCase);
    });

    it('should match known models case-insensitively', () => {
      const mixedCase = getModelTokenLimit('JINAAI/JINA-EMBEDDINGS-V2-BASE-CODE');
      expect(mixedCase).toBe(8192);
    });
  });
});

describe('Chunking Parameters', () => {
  describe('getChunkingParams', () => {
    it('should return correct params for default model', () => {
      const params = getChunkingParams('jinaai/jina-embeddings-v2-base-code');

      expect(params.maxTokens).toBe(8192);
      expect(params.targetTokens).toBeLessThan(8192); // 85% of max
      expect(params.targetTokens).toBeGreaterThan(6000);
      expect(params.overlapTokens).toBeLessThan(params.targetTokens);
    });

    it('should calculate ~85% for target tokens', () => {
      const params = getChunkingParams('jinaai/jina-embeddings-v2-base-code'); // 8192 limit

      // 85% of 8192 = 6963.2 -> floor = 6963
      expect(params.targetTokens).toBe(Math.floor(8192 * 0.85));
    });

    it('should calculate ~18% overlap', () => {
      const params = getChunkingParams('jinaai/jina-embeddings-v2-base-code');

      const expectedOverlap = Math.floor(params.targetTokens * 0.18);
      expect(params.overlapTokens).toBe(expectedOverlap);
    });

    it('should return all three parameters', () => {
      const params = getChunkingParams('Xenova/all-MiniLM-L6-v2');

      expect(params).toHaveProperty('maxTokens');
      expect(params).toHaveProperty('targetTokens');
      expect(params).toHaveProperty('overlapTokens');
    });

    it('should handle unknown models with defaults', () => {
      const params = getChunkingParams('unknown/model');

      expect(params.maxTokens).toBe(512);
      expect(params.targetTokens).toBeLessThan(512);
    });
  });
});

describe('Token Limit Checking', () => {
  describe('exceedsTokenLimit', () => {
    it('should return false for short text', () => {
      const shortText = 'hello world';
      expect(exceedsTokenLimit(shortText, 'jinaai/jina-embeddings-v2-base-code')).toBe(false);
    });

    it('should return true for very long text', () => {
      // Create text that definitely exceeds 8192 tokens
      // "word " is 1 token + space, roughly. 10000 words should do it.
      const longText = 'word '.repeat(10000);
      expect(exceedsTokenLimit(longText, 'jinaai/jina-embeddings-v2-base-code')).toBe(true);
    });

    it('should handle empty text', () => {
      expect(exceedsTokenLimit('', 'jinaai/jina-embeddings-v2-base-code')).toBe(false);
    });
  });
});

describe('Integration: Token Estimation Accuracy', () => {
  it('should estimate reasonable tokens for typical code chunks', () => {
    const typicalCodeChunk = `
      import { pipeline } from '@xenova/transformers';
      
      export class MyClass {
        constructor(config) {
          this.config = config;
          this.data = [];
        }
        
        async process(input) {
          const result = await this.transform(input);
          return result.map(item => item.value);
        }
      }
    `;

    const tokens = estimateTokens(typicalCodeChunk);

    // Should be within typical chunk size
    expect(tokens).toBeGreaterThan(30);
    expect(tokens).toBeLessThan(200);
  });

  it('should keep small code chunks under model limits', () => {
    // A small chunk should definitely be under the limit
    const safeChunk = 'const x = 1;\n'.repeat(10);

    expect(exceedsTokenLimit(safeChunk, 'jinaai/jina-embeddings-v2-base-code')).toBe(false);
  });
});
