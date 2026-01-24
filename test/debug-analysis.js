
import { smartChunk } from './lib/utils.js';

const mockConfig = { embeddingModel: 'mock-model' };

// Mock tokenizer
import { vi } from 'vitest';
const estimateTokens = (str) => str.length;
const getChunkingParams = () => ({
    maxTokens: 50,
    targetTokens: 30, 
    overlapTokens: 5
});

// Mocking dependencies manually since we are running with node directly
// We need to overwrite the imports in utils.js or mock them.
// Since utils.js imports from tokenizer.js, we can't easily mock that with just node unless we use a loader or modify utils.js.
// So instead, let's create a temporary modified version of utils.js or just run the test file with console.log and capture output.

// Actually, I can use the existing test file but add logging there and run with `npm test ...` and look closer at output?
// The previous run captured stderr, but maybe I missed it?
// The output showed "Failed Tests 1", but no console.error output from my previous change.

// Wait, I see "stderr | test/index-codebase-phase2.test.js" in previous logs, but not for utils-branches.test.js.
// Vitest might suppress console output if test fails? Or implies it.

// Let's rely on reading the code again manually.

// Code:
/*
196:     if (inComment) {
197:       // Look for end of block comment
198:       if (line.includes('*\u002f')) {
             ...
200:         // If there's content after the comment, process it (simplified)
201:         if (parts[parts.length - 1].trim().length > 0) {
202:           inComment = false;
204:           // We just assume the line is mixed and skip granular checks
205:         } else {
206:           inComment = false;
207:         }
208:       }
209:     } 
*/

// If `inComment` is true and line does NOT include `*/`, it goes to... nowhere?
// line 209 ends the `if (inComment)` block.
// Then line 251: `// Split lines that are too large...`
// Then line 336: `currentChunk.push(line);`

// Wait. If `inComment` is true, we just skip the character analysis (lines 210-249).
// We DO fall through to `currentChunk.push(line)` (line 336).

// So "middle line" SHOULD be added to `currentChunk`.

// Why is it not in the output?
// Maybe `estimateTokens` is returning 0 or small number, and it gets flushed/dropped?
// `smartChunk` calls `estimateTokens(line)` (line 192).

// In my test: `expect(chunks[0].text).toContain('middle line');`
// `chunks` length IS > 0 (checked).
// But text doesn't contain it.

// Maybe it was put in a chunk that was then dropped?
// `chunkText.trim().length > 20` check?
// content was `/*\n middle line \n*/\n` + "x".repeat(40)
// Line 1: `/*` -> pushed.
// Line 2: ` middle line ` -> pushed.
// Line 3: `*/` -> pushed.
// Line 4: `xxxxxxxx...` -> pushed?

// Wait, line tokens.
// "middle line" has spaces. `trim()` length is ~11 chars.
// If it's pushed to `currentChunk`.
// Then we hit the oversized line (x*40).
// Line 252: `if (lineTokens > maxTokens)`
// x*40 is 40 tokens. maxTokens is 50. So it is NOT oversized.

// Wait, input setup: `const content = "/*\n middle line \n*/\n" + "x".repeat(40);`
// Line 4 is "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" (40 chars).

// currentChunk has: "/*", " middle line ", "*/", "xxxx..."
// Total tokens?
// 2 + 13 + 2 + 40 = 57.
// targetTokens is 30.
// So `wouldExceedLimit` (line 283) might be true?

// Line 283: `currentChunk` (17 tokens) + `line` (40 tokens) = 57 > 30.
// `wouldExceedLimit` = true.

// `shouldSplit` = true (line 301).
// `safeToSplit` = true (line 305).

// Line 307: `if (shouldSplit && safeToSplit && currentChunk.length > 0)`
// -> Flush currentChunk ("/*", " middle line ", "*/").
// -> Text: "/*\n middle line \n*/". Length ~ 20.

// "/*" (2) + "\n" (1) + " middle line " (13) + "\n" (1) + "*/" (2) = 19 chars.
// 20 chars? "/*\n middle line \n*/" has length 2 + 1 + 13 + 1 + 2 = 19.
// `chunkText.trim().length > 20` (line 255/309) -> 19 <= 20 -> FALSE.
// CHUNK DROPPED!

// That explains it. The chunk containing the comment is being dropped because it's too small.

// Fix: Make the comment content longer!

console.log('Analysis complete: Middle line chunk is dropped because total size is < 20 chars.');
