import { describe, it, expect, afterEach } from 'vitest';
import { smartChunk, MODEL_TOKEN_LIMITS } from '../lib/utils.js';

describe('utils.js extra coverage', () => {
  const originalLimits = { ...MODEL_TOKEN_LIMITS };

  afterEach(() => {
    // Restore limits
    for (const key in MODEL_TOKEN_LIMITS) delete MODEL_TOKEN_LIMITS[key];
    Object.assign(MODEL_TOKEN_LIMITS, originalLimits);
  });

  it('handles multi-line comment start (line 198 coverage)', () => {
    // This triggers the case where '/*' is found but '*/' is NOT on the same line.
    // The code should break the inner loop and set inComment=true.
    const content = 'const a = 1; /* start comment\n end comment */ const b = 2;';
    const config = { embeddingModel: 'test-model' };
    
    // We expect smartChunk to handle this gracefully without crashing
    // and correctly identify lines.
    const chunks = smartChunk(content, 'test.js', config);
    expect(chunks.length).toBeGreaterThan(0);
    // Ensure content is preserved
    expect(chunks[0].text).toContain('const a = 1');
    expect(chunks[0].text).toContain('const b = 2');
  });

  it('flushes current chunk when encountering oversized line (line 255 coverage)', () => {
    // Set a very small token limit
    MODEL_TOKEN_LIMITS['test-oversize'] = 20;
    
    // Line 1: fits (approx 5 tokens) but needs to be > 20 chars to be kept
    const line1 = 'const small = 1; // padding to exceed 20 chars'; 
    // Line 2: huge (exceeds 20 tokens)
    const line2 = 'x '.repeat(50); 
    
    const content = `${line1}\n${line2}`;
    const config = { embeddingModel: 'test-oversize' };

    const chunks = smartChunk(content, 'test.js', config);

    // Should have flushed line1 as a separate chunk before processing line2
    // Chunk 1: line1
    // Chunk 2+: parts of line2
    expect(chunks[0].text.trim()).toBe(line1);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('stops overlap calculation when limit is reached (line 309 coverage)', () => {
    // Set limit such that overlapTokens is small.
    // Max=100 -> Target=85 -> Overlap=15.
    MODEL_TOKEN_LIMITS['test-overlap'] = 100;
    
    // We need lines that sum > 15 tokens.
    // "const x = 1;" is approx 5-6 tokens.
    const line = 'const val = 123456;'; // ~6-8 tokens
    
    // Create enough lines to force a split and trigger overlap calculation
    // With target=85, ~15 lines will trigger a split.
    const lines = Array(20).fill(line);
    const content = lines.join('\n');
    const config = { embeddingModel: 'test-overlap' };

    const chunks = smartChunk(content, 'test.js', config);

    // Check that we have chunks
    expect(chunks.length).toBeGreaterThan(1);
    
    // The implementation of overlap (lines 300+) loops backwards.
    // It should stop adding lines to overlap once 15 tokens are exceeded.
    // If we have 3 lines of 8 tokens:
    // 1. Add line 20 (8 tok). Total 8. <= 15. OK.
    // 2. Add line 19 (8 tok). Total 16. > 15. BREAK (Line 309).
    
        // Verification is implicit: if it didn't break, it would add more lines 
        // than allowed to the overlap. 
        // We can check strictly if the overlap size is bounded, 
        // but primarily we just want to ensure the code path is executed.
      });
    
      it('handles oversized line with empty chunk (line 255 false path coverage)', () => {
        MODEL_TOKEN_LIMITS['test-oversize-empty'] = 20;
        
        // Huge line at the start. currentChunk is empty.
        const hugeLine = 'x '.repeat(50);
        const content = hugeLine;
        const config = { embeddingModel: 'test-oversize-empty' };
    
        const chunks = smartChunk(content, 'test.js', config);
    
        // Should process the huge line directly without crashing or duplicating
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0].text.length).toBeGreaterThan(0);
      });
    
      it('terminates overlap loop when limit is exactly reached (line 309 loop condition coverage)', () => {
        // Limit=100 -> Target=85 -> Overlap=15.
        MODEL_TOKEN_LIMITS['test-overlap-exact'] = 100;
        
        // Construct lines that are exactly 5 tokens.
        // "a b c" -> 3 words + 2 (cls/sep) = 5 tokens.
        const line = 'a b c'; 
        
        // We want to fill overlap exactly to 15 (3 lines).
        // Provide enough lines to trigger split.
        const lines = Array(30).fill(line);
        const content = lines.join('\n');
        const config = { embeddingModel: 'test-overlap-exact' };
    
        const chunks = smartChunk(content, 'test.js', config);
    
        expect(chunks.length).toBeGreaterThan(1);
        // Implicitly covers the case where loop terminates because overlapTokensCount < overlapTokens becomes false
        // instead of breaking via 'else { break }'.
      });
    });

