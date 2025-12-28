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
  MODEL_TOKEN_LIMITS 
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
      expect(MODEL_TOKEN_LIMITS['default']).toBe(256);
    });
    
    it('should have limits for MiniLM models', () => {
      expect(MODEL_TOKEN_LIMITS['Xenova/all-MiniLM-L6-v2']).toBe(256);
      expect(MODEL_TOKEN_LIMITS['Xenova/all-MiniLM-L12-v2']).toBe(256);
    });
    
    it('should have limits for code-specific models', () => {
      expect(MODEL_TOKEN_LIMITS['Xenova/codebert-base']).toBe(512);
      expect(MODEL_TOKEN_LIMITS['Xenova/graphcodebert-base']).toBe(512);
    });
    
    it('should have limits for E5 and BGE models', () => {
      expect(MODEL_TOKEN_LIMITS['Xenova/e5-small-v2']).toBe(512);
      expect(MODEL_TOKEN_LIMITS['Xenova/bge-base-en-v1.5']).toBe(512);
    });
  });

  describe('getModelTokenLimit', () => {
    it('should return correct limit for known models', () => {
      expect(getModelTokenLimit('Xenova/all-MiniLM-L6-v2')).toBe(256);
      expect(getModelTokenLimit('Xenova/codebert-base')).toBe(512);
    });
    
    it('should return default for unknown models', () => {
      expect(getModelTokenLimit('unknown/model-name')).toBe(256);
    });
    
    it('should return default for null/undefined', () => {
      expect(getModelTokenLimit(null)).toBe(256);
      expect(getModelTokenLimit(undefined)).toBe(256);
    });
    
    it('should be case-insensitive', () => {
      const normalCase = getModelTokenLimit('Xenova/all-MiniLM-L6-v2');
      const lowerCase = getModelTokenLimit('xenova/all-minilm-l6-v2');
      
      expect(lowerCase).toBe(normalCase);
    });
  });
});

describe('Chunking Parameters', () => {
  describe('getChunkingParams', () => {
    it('should return correct params for default model', () => {
      const params = getChunkingParams('Xenova/all-MiniLM-L6-v2');
      
      expect(params.maxTokens).toBe(256);
      expect(params.targetTokens).toBeLessThan(256); // 85% of max
      expect(params.targetTokens).toBeGreaterThan(200);
      expect(params.overlapTokens).toBeLessThan(params.targetTokens);
    });
    
    it('should calculate ~85% for target tokens', () => {
      const params = getChunkingParams('Xenova/codebert-base'); // 512 limit
      
      // 85% of 512 = 435.2 -> floor = 435
      expect(params.targetTokens).toBe(Math.floor(512 * 0.85));
    });
    
    it('should calculate ~18% overlap', () => {
      const params = getChunkingParams('Xenova/all-MiniLM-L6-v2');
      
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
      
      expect(params.maxTokens).toBe(256);
      expect(params.targetTokens).toBeLessThan(256);
    });
  });
});

describe('Token Limit Checking', () => {
  describe('exceedsTokenLimit', () => {
    it('should return false for short text', () => {
      const shortText = 'hello world';
      expect(exceedsTokenLimit(shortText, 'Xenova/all-MiniLM-L6-v2')).toBe(false);
    });
    
    it('should return true for very long text', () => {
      // Create text that definitely exceeds 256 tokens
      const longText = 'word '.repeat(500);
      expect(exceedsTokenLimit(longText, 'Xenova/all-MiniLM-L6-v2')).toBe(true);
    });
    
    it('should consider different model limits', () => {
      // Create text that exceeds 256 but not 512
      const mediumText = 'word '.repeat(300);
      
      // Should exceed small model limit
      expect(exceedsTokenLimit(mediumText, 'Xenova/all-MiniLM-L6-v2')).toBe(true);
      
      // Should not exceed large model limit
      expect(exceedsTokenLimit(mediumText, 'Xenova/codebert-base')).toBe(false);
    });
    
    it('should handle empty text', () => {
      expect(exceedsTokenLimit('', 'Xenova/all-MiniLM-L6-v2')).toBe(false);
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
    
    expect(exceedsTokenLimit(safeChunk, 'Xenova/all-MiniLM-L6-v2')).toBe(false);
  });
});
