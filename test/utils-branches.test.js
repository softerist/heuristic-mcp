
import { describe, it, expect, vi } from 'vitest';
import { smartChunk } from '../lib/utils.js';

describe('Utils Branch Coverage', () => {
  const mockConfig = { embeddingModel: 'mock-model' };
  
  // Mock tokenizer to return predictable token counts
  vi.mock('../lib/tokenizer.js', () => ({
    estimateTokens: (str) => str.length,
    getChunkingParams: () => ({
        maxTokens: 50,
        targetTokens: 30, // Trigger splitting heuristics
        overlapTokens: 5
    })
  }));

  describe('smartChunk', () => {
    it('should ignore short chunks when flushing oversized line (line 255 branch)', () => {
        // Condition:
        // 1. currentChunk.length > 0 (lines 253)
        // 2. new line causes token limit exceeded (line 252)
        // 3. currentChunk text ("<20 chars") triggers line 255 check (chunkText.trim().length > 20)
        
        // Setup:
        // Chunk 1: "short" (5 chars)
        // Chunk 2: "very_long_line_that_exceeds_max_tokens_continuously_to_trigger_split" (60+ chars)
        
        const content = "short\n" + "x".repeat(60);
        const chunks = smartChunk(content, 'test.js', mockConfig);
        
        // Verification:
        // "short" should NOT be emitted as a standalone chunk because it is < 20 chars
        // The oversized line will be split and emitted.
        
        const shortChunk = chunks.find(c => c.text === 'short');
        expect(shortChunk).toBeUndefined();
        
        // Check that oversized line IS produced (sanity check)
        expect(chunks.length).toBeGreaterThan(0);
    });

    it('should ignoring short chunks when splitting (line 309 branch)', () => {
        // Condition:
        // 1. shouldSplit is true (line 301)
        // 2. safeToSplit is true (line 305)
        // 3. currentChunk.length > 0 (line 307)
        // 4. currentChunk text < 20 chars (line 309)
        
        // Setup:
        // maxTokens=50, targetTokens=30.
        // Line 1: "short" (5 tokens)
        // Line 2: "medium_length_line_to_trigger_limit" (35 tokens)
        // Total 40 > 30 (target).
        // Split should happen.
        // "short" is flushed. < 20 chars -> dropped.
        
        const content = "short\n" + "m".repeat(35);
        const chunks = smartChunk(content, 'test.js', mockConfig);
        
        // "short" is dropped
        const shortChunk = chunks.find(c => c.text === 'short');
        expect(shortChunk).toBeUndefined();
        
        // The medium line should start a new chunk?
        // Or be added to next?
        // Logic: 
        // if (shouldSplit...) { flush current; overlap...; current = overlap; }
        // then push current line.
        
        // So "short" is flushed (dropped).
        // Then overlap (short) becomes new current?
        // Wait, line 319 overlap logic uses currentChunk.
        // If "short" is < 20, it is NOT pushed to chunks.
        // BUT it IS used for overlap!
        // So new chunk starts with "short" + "medium..."?
        
        // If overlapTokens=5, "short" (5 chars) fits?
        // If so, next chunk = "short\nmedium..."
        
        // Let's inspect results
        // We expect NO chunk that is JUST "short"
        expect(chunks.some(c => c.text.trim() === 'short')).toBe(false);
    });

    it('should handle multi-line comment continuation (line 198)', () => {
        // Condition:
        // 1. inComment = true (lines 196)
        // 2. line includes '*/' (line 198)
        
        // Setup:
        // Line 1: "/*" -> sets inComment=true
        // Line 2: " content */ code"
        
        const content = "/*\n content */ code \n" + "x".repeat(30); 
        const chunks = smartChunk(content, 'test.js', mockConfig);
        
        // Just verify it doesn't crash and logic flows
        // This is mainly for coverage
        expect(chunks.length).toBeGreaterThan(0);
    });

    it('should handle multi-line comment middle lines (line 198 false branch)', () => {
        // Condition:
        // 1. inComment = true
        // 2. line DOES NOT include '*/'
        
        // Setup:
        // Line 1: "/*" (starts comment)
        // Line 2: " middle line without end token " (inComment=true, .includes('*/')=false)
        // Line 3: "*/" (ends comment)
        



        const content = "/*\n middle line that is sufficiently long to not be dropped \n*/\n" + "x".repeat(40);
        const chunks = smartChunk(content, 'test.js', mockConfig);
        
        console.error('Chunks produced:', chunks.map(c => c.text));

        // Should produce chunks
        expect(chunks.length).toBeGreaterThan(0);
        
        // At least one chunk should contain "middle line"
        // (It might be merged with others or in its own chunk)

        const hasText = chunks.some(c => c.text.includes('middle line'));
        expect(hasText).toBe(true);
    });

    it('should flush long chunk when encountering oversized line (line 255/256 true branch)', () => {
        // Condition:
        // 1. currentChunk > 20 chars
        // 2. Next line is oversized -> triggers flush
        
        const longText = "this is a sufficiently long line to be preserved";
        const content = longText + "\n" + "x".repeat(60);
        const chunks = smartChunk(content, 'test.js', mockConfig);
        
        // Assert the long text is preserved in its own chunk
        const preservedChunk = chunks.find(c => c.text === longText);
        expect(preservedChunk).toBeDefined();
    });


    it('should flush long chunk when splitting (line 309/310 true branch)', () => {
        // Condition:
        // 1. shouldSplit = true
        // 2. currentChunk > 20 chars -> triggers flush
        
        // Needs to be < maxTokens (50) but > 20 chars
        const longText = "line preserved during split"; // 27 chars
        const content = longText + "\n" + "m".repeat(35); // 35 tokens. Total 27+35 = 62 > 30 target.
        const chunks = smartChunk(content, 'test.js', mockConfig);
        
        // Assert preserved
        const hasText = chunks.some(c => c.text.includes(longText));
        expect(hasText).toBe(true);
    });
  });
});
