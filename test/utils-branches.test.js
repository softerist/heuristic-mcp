import { describe, it, expect, vi } from 'vitest';
import { smartChunk } from '../lib/utils.js';

describe('Utils Branch Coverage', () => {
  const mockConfig = { embeddingModel: 'mock-model' };

  
  vi.mock('../lib/tokenizer.js', () => ({
    estimateTokens: (str) => str.length,
    getChunkingParams: () => ({
      maxTokens: 50,
      targetTokens: 30, 
      overlapTokens: 5,
    }),
  }));

  describe('smartChunk', () => {
    it('should ignore short chunks when flushing oversized line (line 255 branch)', () => {
      
      
      
      

      
      
      

      const content = 'short\n' + 'x'.repeat(60);
      const chunks = smartChunk(content, 'test.js', mockConfig);

      
      
      

      const shortChunk = chunks.find((c) => c.text === 'short');
      expect(shortChunk).toBeUndefined();

      
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should ignoring short chunks when splitting (line 309 branch)', () => {
      
      
      
      
      

      
      
      
      
      
      
      

      const content = 'short\n' + 'm'.repeat(35);
      const chunks = smartChunk(content, 'test.js', mockConfig);

      
      const shortChunk = chunks.find((c) => c.text === 'short');
      expect(shortChunk).toBeUndefined();

      
      
      
      
      

      
      
      
      
      
      

      
      

      
      
      expect(chunks.some((c) => c.text.trim() === 'short')).toBe(false);
    });

    it('should handle multi-line comment continuation (line 198)', () => {
      
      
      

      
      
      

      const content = '/*\n content */ code \n' + 'x'.repeat(30);
      const chunks = smartChunk(content, 'test.js', mockConfig);

      
      
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should handle multi-line comment middle lines (line 198 false branch)', () => {
      
      
      

      
      
      
      

      const content =
        '/*\n middle line that is sufficiently long to not be dropped \n*/\n' + 'x'.repeat(40);
      const chunks = smartChunk(content, 'test.js', mockConfig);

      console.error(
        'Chunks produced:',
        chunks.map((c) => c.text)
      );

      
      expect(chunks.length).toBeGreaterThan(0);

      
      

      const hasText = chunks.some((c) => c.text.includes('middle line'));
      expect(hasText).toBe(true);
    });

    it('should flush long chunk when encountering oversized line (line 255/256 true branch)', () => {
      
      
      

      const longText = 'this is a sufficiently long line to be preserved';
      const content = longText + '\n' + 'x'.repeat(60);
      const chunks = smartChunk(content, 'test.js', mockConfig);

      
      const preservedChunk = chunks.find((c) => c.text === longText);
      expect(preservedChunk).toBeDefined();
    });

    it('should flush long chunk when splitting (line 309/310 true branch)', () => {
      
      
      

      
      const longText = 'line preserved during split'; 
      const content = longText + '\n' + 'm'.repeat(35); 
      const chunks = smartChunk(content, 'test.js', mockConfig);

      
      const hasText = chunks.some((c) => c.text.includes(longText));
      expect(hasText).toBe(true);
    });
  });
});
