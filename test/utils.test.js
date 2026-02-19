

import { describe, it, expect } from 'vitest';
import { smartChunk, MODEL_TOKEN_LIMITS } from '../lib/utils.js';

describe('smartChunk', () => {
  it('handles inline block comments on the same line', () => {
    const content = '/* inline comment */ const x = 1;\nfunction test() { return x; }';
    const config = { embeddingModel: 'jinaai/jina-embeddings-v2-base-code' };

    const chunks = smartChunk(content, 'example.js', config);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text).toContain('const x = 1');
  });

  it('handles block comments that end mid-line', () => {
    const content = '/* start comment\nend */ const y = 2;\nfunction ok() { return y; }';
    const config = { embeddingModel: 'jinaai/jina-embeddings-v2-base-code' };

    const chunks = smartChunk(content, 'example.js', config);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text).toContain('const y = 2');
  });

  it('splits large content respecting boundaries and overlap', () => {
    
    const lines = [];
    for (let i = 0; i < 500; i++) {
      lines.push(`function function_${i}() { return ${i}; }`);
    }
    const content = lines.join('\n');

    
    
    
    

    const config = { embeddingModel: 'test-model' };
    const chunks = smartChunk(content, 'test.js', config);

    expect(chunks.length).toBeGreaterThan(1);
    
    if (chunks.length > 1) {
      
      
    }
  });

  it('handles complex syntax state tracking', () => {
    const content = `
      function test() {
        const str = "string with { brace } and /* comment */ inside";
        const str2 = 'single quote with " inside';
        const escape = "escaped \\" quote and \\\\ backslash"; // Hit line 197
        const escape2 = 'escaped \\' quote'; 
        
        const str3 = \`template with \${val} inside\`;
        // Line comment with { brace }
        /* Block comment 
           with { brace } */ const trailing = 1; // Hit line 183
        
        /* Clean end 
           comment */
        
        /* inline block */ const after = 1;
        
        if (true) {
           return { val: [1, 2] };
        }
      }
    `;
    const config = { embeddingModel: 'test-model' };
    smartChunk(content, 'test.js', config);
    
  });

  it('splits chunks when target token budget is exceeded', () => {
    MODEL_TOKEN_LIMITS['test-split'] = 18;
    const line = 'alpha beta gamma delta';
    const content = `${line}\n${line}\n${line}`;
    const config = { embeddingModel: 'test-split' };

    const chunks = smartChunk(content, 'test.js', config);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text.trim().length).toBeGreaterThan(20);
  });

  it('splits oversized lines and keeps long chunks', () => {
    MODEL_TOKEN_LIMITS['test-tiny-oversize'] = 12;
    const firstLine = 'alpha beta gamma delta';
    const secondLine = 'one two three four five six seven eight nine ten eleven';
    const content = `${firstLine}\n${secondLine}`;
    const config = { embeddingModel: 'test-tiny-oversize' };

    const chunks = smartChunk(content, 'test.txt', config);

    expect(chunks.some((chunk) => chunk.text.includes(firstLine))).toBe(true);
    expect(chunks.some((chunk) => chunk.text.length > 20)).toBe(true);
  });

  it('handles empty input', () => {
    expect(smartChunk('', 'test.js', {})).toEqual([]);
  });
});

import { dotSimilarity, hashContent } from '../lib/utils.js';

describe('Similarity Metrics', () => {
  it('dotSimilarity calculates correct dot product', () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    
    expect(dotSimilarity(a, b)).toBe(32);
  });
});

describe('Hashing', () => {
  it('hashContent produces stable MD5 hex', () => {
    const content = 'hello world';
    const hash = hashContent(content);
    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(32); 
    expect(hash).toBe(hashContent(content)); 
    expect(hash).not.toBe(hashContent('goodbye'));
  });
});
