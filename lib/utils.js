import crypto from 'crypto';
import path from 'path';
import { estimateTokens, getChunkingParams } from './tokenizer.js';

// Re-export tokenizer utilities
export {
  estimateTokens,
  getChunkingParams,
  getModelTokenLimit,
  MODEL_TOKEN_LIMITS,
} from './tokenizer.js';

// Minimum text length for a chunk to be considered valid (avoids tiny fragments)
import { MIN_CHUNK_TEXT_LENGTH } from './constants.js';

/**
 * Fast similarity for normalized vectors (dot product).
 * Uses loop unrolling for performance on large vectors.
 * NOTE: For very large codebases (10k+ chunks), consider WebAssembly SIMD
 * for ~2-4x speedup on 768-dim vectors.
 * @param {Float32Array} a - First normalized vector
 * @param {Float32Array} b - Second normalized vector
 * @returns {number} Dot product similarity score (-1 to 1 for normalized vectors)
 * @throws {Error} If vectors are null/undefined or have different dimensions
 */
export function dotSimilarity(a, b) {
  if (!a || !b) {
    throw new Error(
      'dotSimilarity requires two non-null vectors. ' +
        'This may indicate a missing embedding or corrupted cache entry.'
    );
  }
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch in dotSimilarity: ${a.length} vs ${b.length}. ` +
      'This may indicate an embedding dimension configuration change. Consider reindexing.'
    );
  }
  let dot = 0;
  let i = 0;
  const len = a.length;
  const m = len % 4;

  while (i < m) {
    dot += a[i] * b[i];
    i++;
  }

  while (i < len) {
    dot += a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3];
    i += 4;
  }

  return dot;
}

/**
 * Generate hash for file content to detect changes
 */
export function hashContent(content) {
  return crypto.createHash('md5').update(content).digest('hex');
}

// Language-specific patterns for function/class detection
const patterns = {
  // JavaScript/TypeScript
  js: /^(export\s+)?(async\s+)?(function|class|const|let|var)\s+\w+/,
  jsx: /^(export\s+)?(async\s+)?(function|class|const|let|var)\s+\w+/,
  ts: /^(export\s+)?(async\s+)?(function|class|const|let|var|interface|type)\s+\w+/,
  tsx: /^(export\s+)?(async\s+)?(function|class|const|let|var|interface|type)\s+\w+/,
  mjs: /^(export\s+)?(async\s+)?(function|class|const|let|var)\s+\w+/,
  cjs: /^(export\s+)?(async\s+)?(function|class|const|let|var)\s+\w+/,

  // Python
  py: /^(class|def|async\s+def)\s+\w+/,
  pyw: /^(class|def|async\s+def)\s+\w+/,
  pyx: /^(cdef|cpdef|def|class)\s+\w+/, // Cython

  // Java/Kotlin/Scala
  java: /^(public|private|protected)?\s*(static\s+)?(class|interface|enum|void|int|String|boolean)\s+\w+/,
  kt: /^(class|interface|object|fun|val|var)\s+\w+/,
  kts: /^(class|interface|object|fun|val|var)\s+\w+/,
  scala: /^(class|object|trait|def|val|var)\s+\w+/,

  // C/C++
  c: /^(struct|enum|union|void|int|char|float|double)\s+\w+/,
  cpp: /^(class|struct|namespace|template|void|int|bool)\s+\w+/,
  cc: /^(class|struct|namespace|template|void|int|bool)\s+\w+/,
  cxx: /^(class|struct|namespace|template|void|int|bool)\s+\w+/,
  h: /^(class|struct|namespace|template|void|int|bool)\s+\w+/,
  hpp: /^(class|struct|namespace|template|void|int|bool)\s+\w+/,
  hxx: /^(class|struct|namespace|template|void|int|bool)\s+\w+/,

  // C#
  cs: /^(public|private|protected)?\s*(static\s+)?(class|interface|struct|enum|void|int|string|bool)\s+\w+/,
  csx: /^(public|private|protected)?\s*(static\s+)?(class|interface|struct|enum|void|int|string|bool)\s+\w+/,

  // Go
  go: /^(func|type|const|var)\s+\w+/,

  // Rust
  rs: /^(pub\s+)?(fn|struct|enum|trait|impl|const|static|mod)\s+\w+/,

  // PHP
  php: /^(class|interface|trait|function|const)\s+\w+/,
  phtml: /^(<\?php|class|interface|trait|function)\s*/,

  // Ruby
  rb: /^(class|module|def)\s+\w+/,
  rake: /^(class|module|def|task|namespace)\s+\w+/,

  // Swift
  swift: /^(class|struct|enum|protocol|func|var|let|extension)\s+\w+/,

  // R
  r: /^(\w+)\s*(<-|=)\s*function/,
  R: /^(\w+)\s*(<-|=)\s*function/,

  // Lua
  lua: /^(function|local\s+function)\s+\w+/,

  // Shell scripts
  sh: /^(\w+\s*\(\)|function\s+\w+)/,
  bash: /^(\w+\s*\(\)|function\s+\w+)/,
  zsh: /^(\w+\s*\(\)|function\s+\w+)/,
  fish: /^function\s+\w+/,

  // CSS/Styles
  css: /^(\.|#|@media|@keyframes|@font-face|\w+)\s*[{,]/,
  scss: /^(\$\w+:|@mixin|@function|@include|\.|#|@media)\s*/,
  sass: /^(\$\w+:|=\w+|\+\w+|\.|#|@media)\s*/,
  less: /^(@\w+:|\.|#|@media)\s*/,
  styl: /^(\$\w+\s*=|\w+\(|\.|#)\s*/,

  // Markup/HTML
  html: /^(<(div|section|article|header|footer|nav|main|aside|form|table|template|script|style)\b)/i,
  htm: /^(<(div|section|article|header|footer|nav|main|aside|form|table|template|script|style)\b)/i,
  xml: /^(<\w+|\s*<!\[CDATA\[)/,
  svg: /^(<svg|<g|<path|<defs|<symbol)\b/,

  // Config files
  json: /^(\s*"[\w-]+"\s*:\s*[[{])/,
  yaml: /^(\w[\w-]*:\s*[|>]?$|\w[\w-]*:\s*$)/,
  yml: /^(\w[\w-]*:\s*[|>]?$|\w[\w-]*:\s*$)/,
  toml: /^(\[\[?\w+\]?\]?|\w+\s*=)/,
  ini: /^(\[\w+\]|\w+\s*=)/,
  env: /^[A-Z_][A-Z0-9_]*=/,

  // Makefile
  makefile: /^([A-Za-z0-9_./-]+)\s*:(?!=)/,
  mk: /^([A-Za-z0-9_./-]+)\s*:(?!=)/,

  // Docker
  dockerfile:
    /^(FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\s+/i,

  // Documentation
  md: /^(#{1,6}\s+|```|\*{3}|_{3})/,
  mdx: /^(#{1,6}\s+|```|import\s+|export\s+)/,
  txt: /^.{50,}/, // Split on long paragraphs
  rst: /^(={3,}|-{3,}|~{3,}|\.\.\s+\w+::)/,

  // Database
  sql: /^(CREATE|ALTER|INSERT|UPDATE|DELETE|SELECT|DROP|GRANT|REVOKE|WITH|DECLARE|BEGIN|END)\s+/i,

  // Perl
  pl: /^(sub|package|use|require)\s+\w+/,
  pm: /^(sub|package|use|require)\s+\w+/,

  // Vim
  vim: /^(function|command|autocmd|let\s+g:)\s*/,
};

/**
 * Intelligent chunking with token limit awareness
 * Tries to split by function/class boundaries while respecting token limits
 *
 * @param {string} content - File content to chunk
 * @param {string} file - File path (for language detection)
 * @param {object} config - Configuration object with embeddingModel
 * @returns {Array<{text: string, startLine: number, endLine: number, tokenCount: number}>}
 */
export function smartChunk(content, file, config) {
  const lines = content.split('\n');
  const chunks = [];
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file).toLowerCase();

  // Get model-specific chunking parameters with optional user overrides
  let { maxTokens, targetTokens, overlapTokens } = getChunkingParams(config.embeddingModel);
  if (config.maxTokens) maxTokens = config.maxTokens;
  if (config.targetTokens) targetTokens = config.targetTokens;
  if (config.overlapTokens) overlapTokens = config.overlapTokens;

  let langPattern = patterns[ext.slice(1)];
  if (!langPattern) {
    if (base === 'dockerfile') langPattern = patterns.dockerfile;
    else if (base === 'makefile') langPattern = patterns.makefile;
    else if (base.startsWith('.env')) langPattern = patterns.env;
  }
  if (!langPattern || typeof langPattern.test !== 'function') {
    langPattern = patterns.js; // Default fallback
  }
  let currentChunk = [];
  let chunkStartLine = 0;

  let currentTokenCount = 0;

  // Track bracket depth for better boundary detection
  let bracketDepth = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let inString = false;
  let inComment = false;
  let stringChar = null; // ' or " or `

  const splitOversizedLine = (line, lineTokens) => {
    const charsPerToken = line.length / Math.max(1, lineTokens);
    const segmentSize = Math.max(100, Math.floor(charsPerToken * targetTokens)); // Min 100 chars
    const segments = [];

    for (let start = 0; start < line.length; start += segmentSize) {
      segments.push(line.slice(start, start + segmentSize));
    }

    return segments;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = estimateTokens(line);

    let j = 0;

    // Simple state tracking for heuristics (not a full parser)
    if (inComment) {
      // Look for end of block comment
      const endIdx = line.indexOf('*/');
      if (endIdx !== -1) {
        inComment = false;
        j = endIdx + 2;
      } else {
        // Skip whole line
        j = line.length;
      }
    }

    const scanLine = j < line.length ? line.slice(j) : '';
    const trimmed = scanLine.trim();

    for (; j < line.length; j++) {
      const char = line[j];
      const nextChar = line[j + 1];

      if (inString) {
        if (char === '\\') {
          j++; // Skip escaped char
        } else if (char === stringChar) {
          inString = false;
          stringChar = null;
        }
      } else {
        // Check for comment start
        if (char === '/' && nextChar === '*') {
          inComment = true;
          j++;
          // Check if it ends on same line
          const endIdx = line.indexOf('*/', j);
          if (endIdx !== -1) {
            inComment = false;
            j = endIdx + 1;
          } else {
            break; // Rest of line is comment
          }
        } else if (char === '/' && nextChar === '/') {
          break; // Skip rest of line (line comment)
        } else if (char === "'" || char === '"' || char === '`') {
          inString = true;
          stringChar = char;
        } else {
          // Only count brackets if not in string or comment
          if (char === '{') braceDepth++;
          else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
          else if (char === '[') bracketDepth++;
          else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
          else if (char === '(') parenDepth++;
          else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
        }
      }
    }

    // Split lines that are too large to ever fit in a single chunk
    if (lineTokens > maxTokens) {
      if (currentChunk.length > 0) {
        const chunkText = currentChunk.join('\n');
        if (chunkText.trim().length > MIN_CHUNK_TEXT_LENGTH) {
          chunks.push({
            text: chunkText,
            startLine: chunkStartLine + 1,
            endLine: i,
            tokenCount: currentTokenCount,
          });
        }
      }

      const parts = splitOversizedLine(line, lineTokens);
      for (const part of parts) {
        if (part.trim().length <= MIN_CHUNK_TEXT_LENGTH) continue;
        chunks.push({
          text: part,
          startLine: i + 1,
          endLine: i + 1,
          tokenCount: estimateTokens(part),
        });
      }

      currentChunk = [];
      currentTokenCount = 0;
      chunkStartLine = i + 1;
      continue;
    }

    // Check if adding this line would exceed token limit
    const wouldExceedLimit = currentTokenCount + lineTokens > targetTokens;

    // Check if this is a good split point using multiple heuristics
    const matchesPattern = langPattern.test(trimmed);
    const atTopLevel =
      braceDepth === 0 && bracketDepth === 0 && parenDepth === 0 && !inString && !inComment;
    const startsAtColumn0 = scanLine.length > 0 && /^\S/.test(scanLine);
    const isEmptyLine = trimmed.length === 0;
    const prevWasEmpty =
      i > 0 && currentChunk.length > 0 && currentChunk.at(-1).trim().length === 0;
    const isCommentStart = /^\s*(\/\*\*|\/\/\s*[-=]{3,}|#\s*[-=]{3,})/.test(scanLine);

    const isGoodSplitPoint =
      currentChunk.length > 3 &&
      ((matchesPattern && (atTopLevel || braceDepth <= 1)) ||
        (atTopLevel && startsAtColumn0 && !isEmptyLine) ||
        (prevWasEmpty && (matchesPattern || isCommentStart)));

    const shouldSplit =
      wouldExceedLimit || (isGoodSplitPoint && currentTokenCount > targetTokens * 0.6);

    // Avoid splitting in weird states if possible
    const safeToSplit = (braceDepth <= 1 && !inString) || wouldExceedLimit;

    if (shouldSplit && safeToSplit && currentChunk.length > 0) {
      const chunkText = currentChunk.join('\n');
      if (chunkText.trim().length > MIN_CHUNK_TEXT_LENGTH) {
        chunks.push({
          text: chunkText,
          startLine: chunkStartLine + 1,
          endLine: i,
          tokenCount: currentTokenCount,
        });
      }

      // Calculate overlap
      let overlapLines = [];
      let overlapTokensCount = 0;
      let overlapStartOffset = 0;  // Track how many lines back we went
      const MAX_OVERLAP_ITERATIONS = 50; // Absolute limit to prevent unbounded loops
      let overlapIterations = 0;
      for (
        let k = currentChunk.length - 1;
        k >= 0 && overlapTokensCount < overlapTokens && overlapIterations < MAX_OVERLAP_ITERATIONS;
        k--
      ) {
        overlapIterations++;
        const lineT = estimateTokens(currentChunk[k]);
        // Guard against infinite loops: if lineT is 0, count the line but don't loop forever
        if (lineT <= 0) {
          // Include zero-token lines (e.g., empty lines) but limit to prevent infinite spin
          // Also guard with overlapStartOffset < 20 to prevent excessive lines even if under 10 in overlapLines
          if (overlapLines.length < 10 && overlapStartOffset < 20) {
            overlapLines.unshift(currentChunk[k]);
            overlapStartOffset++;
          }
          continue;
        }
        if (overlapTokensCount + lineT <= overlapTokens) {
          overlapLines.unshift(currentChunk[k]);
          overlapTokensCount += lineT;
          overlapStartOffset++;
        } else {
          break;
        }
      }

      currentChunk = overlapLines;
      currentTokenCount = overlapTokensCount;
      // The new chunk starts from where the overlap begins in the original file
      // i is the current line we're about to process, overlap lines are from before
      // Ensure non-negative to handle edge cases where overlapStartOffset > i
      chunkStartLine = Math.max(0, i - overlapStartOffset);
    }

    currentChunk.push(line);
    currentTokenCount += lineTokens;

    if (chunks.length >= (config.maxChunksPerFile || 1000)) {
      // Hard limit to prevent memory explosion on minified/data files
      break;
    }
  }

  // Add remaining chunk
  const chunkText = currentChunk.join('\n');
  if (chunkText.trim().length > MIN_CHUNK_TEXT_LENGTH) {
    chunks.push({
      text: chunkText,
      startLine: chunkStartLine + 1,
      endLine: lines.length,
      tokenCount: currentTokenCount,
    });
  }

  return chunks;
}
