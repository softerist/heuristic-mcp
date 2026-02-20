import crypto from 'crypto';
import path from 'path';
import { estimateTokens, getChunkingParams } from './tokenizer.js';

export {
  estimateTokens,
  getChunkingParams,
  getModelTokenLimit,
  MODEL_TOKEN_LIMITS,
} from './tokenizer.js';

import { MIN_CHUNK_TEXT_LENGTH } from './constants.js';

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

export function hashContent(content) {
  return crypto.createHash('md5').update(content).digest('hex');
}

const patterns = {
  js: /^(export\s+)?(async\s+)?(function|class|const|let|var)\s+\w+/,
  jsx: /^(export\s+)?(async\s+)?(function|class|const|let|var)\s+\w+/,
  ts: /^(export\s+)?(async\s+)?(function|class|const|let|var|interface|type)\s+\w+/,
  tsx: /^(export\s+)?(async\s+)?(function|class|const|let|var|interface|type)\s+\w+/,
  mjs: /^(export\s+)?(async\s+)?(function|class|const|let|var)\s+\w+/,
  cjs: /^(export\s+)?(async\s+)?(function|class|const|let|var)\s+\w+/,

  py: /^(class|def|async\s+def)\s+\w+/,
  pyw: /^(class|def|async\s+def)\s+\w+/,
  pyx: /^(cdef|cpdef|def|class)\s+\w+/,

  java: /^(public|private|protected)?\s*(static\s+)?(class|interface|enum|void|int|String|boolean)\s+\w+/,
  kt: /^(class|interface|object|fun|val|var)\s+\w+/,
  kts: /^(class|interface|object|fun|val|var)\s+\w+/,
  scala: /^(class|object|trait|def|val|var)\s+\w+/,

  c: /^(struct|enum|union|void|int|char|float|double)\s+\w+/,
  cpp: /^(class|struct|namespace|template|void|int|bool)\s+\w+/,
  cc: /^(class|struct|namespace|template|void|int|bool)\s+\w+/,
  cxx: /^(class|struct|namespace|template|void|int|bool)\s+\w+/,
  h: /^(class|struct|namespace|template|void|int|bool)\s+\w+/,
  hpp: /^(class|struct|namespace|template|void|int|bool)\s+\w+/,
  hxx: /^(class|struct|namespace|template|void|int|bool)\s+\w+/,

  cs: /^(public|private|protected)?\s*(static\s+)?(class|interface|struct|enum|void|int|string|bool)\s+\w+/,
  csx: /^(public|private|protected)?\s*(static\s+)?(class|interface|struct|enum|void|int|string|bool)\s+\w+/,

  go: /^(func|type|const|var)\s+\w+/,

  rs: /^(pub\s+)?(fn|struct|enum|trait|impl|const|static|mod)\s+\w+/,

  php: /^(class|interface|trait|function|const)\s+\w+/,
  phtml: /^(<\?php|class|interface|trait|function)\s*/,

  rb: /^(class|module|def)\s+\w+/,
  rake: /^(class|module|def|task|namespace)\s+\w+/,

  swift: /^(class|struct|enum|protocol|func|var|let|extension)\s+\w+/,

  r: /^(\w+)\s*(<-|=)\s*function/,
  R: /^(\w+)\s*(<-|=)\s*function/,

  lua: /^(function|local\s+function)\s+\w+/,

  sh: /^(\w+\s*\(\)|function\s+\w+)/,
  bash: /^(\w+\s*\(\)|function\s+\w+)/,
  zsh: /^(\w+\s*\(\)|function\s+\w+)/,
  fish: /^function\s+\w+/,

  css: /^(\.|#|@media|@keyframes|@font-face|\w+)\s*[{,]/,
  scss: /^(\$\w+:|@mixin|@function|@include|\.|#|@media)\s*/,
  sass: /^(\$\w+:|=\w+|\+\w+|\.|#|@media)\s*/,
  less: /^(@\w+:|\.|#|@media)\s*/,
  styl: /^(\$\w+\s*=|\w+\(|\.|#)\s*/,

  html: /^(<(div|section|article|header|footer|nav|main|aside|form|table|template|script|style)\b)/i,
  htm: /^(<(div|section|article|header|footer|nav|main|aside|form|table|template|script|style)\b)/i,
  xml: /^(<\w+|\s*<!\[CDATA\[)/,
  svg: /^(<svg|<g|<path|<defs|<symbol)\b/,

  json: /^(\s*"[\w-]+"\s*:\s*[[{])/,
  yaml: /^(\w[\w-]*:\s*[|>]?$|\w[\w-]*:\s*$)/,
  yml: /^(\w[\w-]*:\s*[|>]?$|\w[\w-]*:\s*$)/,
  toml: /^(\[\[?\w+\]?\]?|\w+\s*=)/,
  ini: /^(\[\w+\]|\w+\s*=)/,
  env: /^[A-Z_][A-Z0-9_]*=/,

  makefile: /^([A-Za-z0-9_./-]+)\s*:(?!=)/,
  mk: /^([A-Za-z0-9_./-]+)\s*:(?!=)/,

  dockerfile:
    /^(FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\s+/i,

  md: /^(#{1,6}\s+|```|\*{3}|_{3})/,
  mdx: /^(#{1,6}\s+|```|import\s+|export\s+)/,
  txt: /^.{50,}/,
  rst: /^(={3,}|-{3,}|~{3,}|\.\.\s+\w+::)/,

  sql: /^(CREATE|ALTER|INSERT|UPDATE|DELETE|SELECT|DROP|GRANT|REVOKE|WITH|DECLARE|BEGIN|END)\s+/i,

  pl: /^(sub|package|use|require)\s+\w+/,
  pm: /^(sub|package|use|require)\s+\w+/,

  vim: /^(function|command|autocmd|let\s+g:)\s*/,
};

export function smartChunk(content, file, config) {
  const lines = content.split('\n');
  const chunks = [];
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file).toLowerCase();
  const SPECIAL_TOKENS = 2;

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
    langPattern = patterns.js;
  }
  let currentChunk = [];
  let chunkStartLine = 0;
  let lineTokenCounts = [];

  let currentTokenCount = 0;

  let bracketDepth = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let inString = false;
  let inComment = false;
  let stringChar = null;

  const splitOversizedLine = (line, lineTokens) => {
    const charsPerToken = line.length / Math.max(1, lineTokens);
    const segmentSize = Math.max(100, Math.floor(charsPerToken * targetTokens));
    const segments = [];

    for (let start = 0; start < line.length; start += segmentSize) {
      segments.push(line.slice(start, start + segmentSize));
    }

    return segments;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = estimateTokens(line, { includeSpecialTokens: false });

    let j = 0;

    if (inComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx !== -1) {
        inComment = false;
        j = endIdx + 2;
      } else {
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
          j++;
        } else if (char === stringChar) {
          inString = false;
          stringChar = null;
        }
      } else {
        if (char === '/' && nextChar === '*') {
          inComment = true;
          j++;

          const endIdx = line.indexOf('*/', j);
          if (endIdx !== -1) {
            inComment = false;
            j = endIdx + 1;
          } else {
            break;
          }
        } else if (char === '/' && nextChar === '/') {
          break;
        } else if (char === "'" || char === '"' || char === '`') {
          inString = true;
          stringChar = char;
        } else {
          if (char === '{') braceDepth++;
          else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
          else if (char === '[') bracketDepth++;
          else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
          else if (char === '(') parenDepth++;
          else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
        }
      }
    }

    if (lineTokens + SPECIAL_TOKENS > maxTokens) {
      if (currentChunk.length > 0) {
        const chunkText = currentChunk.join('\n');
        if (chunkText.trim().length > MIN_CHUNK_TEXT_LENGTH) {
          const endLine = chunkStartLine + currentChunk.length;
          chunks.push({
            text: chunkText,
            startLine: chunkStartLine + 1,
            endLine,
            tokenCount: currentTokenCount + SPECIAL_TOKENS,
          });
        }
      }

      const parts = splitOversizedLine(line, lineTokens);
      for (const part of parts) {
        if (part.trim().length <= MIN_CHUNK_TEXT_LENGTH) continue;
        const partTokens = estimateTokens(part, { includeSpecialTokens: false });
        chunks.push({
          text: part,
          startLine: i + 1,
          endLine: i + 1,
          tokenCount: partTokens + SPECIAL_TOKENS,
        });
      }

      currentChunk = [];
      lineTokenCounts = [];
      currentTokenCount = 0;
      chunkStartLine = i + 1;
      continue;
    }

    const effectiveTokenCount = currentTokenCount + SPECIAL_TOKENS;
    const wouldExceedLimit = currentTokenCount + lineTokens + SPECIAL_TOKENS > targetTokens;

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
      wouldExceedLimit || (isGoodSplitPoint && effectiveTokenCount > targetTokens * 0.6);

    const safeToSplit = (braceDepth <= 1 && !inString) || wouldExceedLimit;

    if (shouldSplit && safeToSplit && currentChunk.length > 0) {
      const chunkText = currentChunk.join('\n');
      if (chunkText.trim().length > MIN_CHUNK_TEXT_LENGTH) {
        const endLine = chunkStartLine + currentChunk.length;
        chunks.push({
          text: chunkText,
          startLine: chunkStartLine + 1,
          endLine,
          tokenCount: currentTokenCount,
        });
      }

      let overlapLines = [];
      let overlapTokensCount = 0;
      let overlapStartOffset = 0;
      const MAX_OVERLAP_ITERATIONS = 50;
      let overlapIterations = 0;
      for (
        let k = currentChunk.length - 1;
        k >= 0 && overlapTokensCount < overlapTokens && overlapIterations < MAX_OVERLAP_ITERATIONS;
        k--
      ) {
        overlapIterations++;

        const lineT = lineTokenCounts[k] ?? 0;

        if (lineT <= 0) {
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

      lineTokenCounts = overlapLines.map((l) => estimateTokens(l, { includeSpecialTokens: false }));
      currentTokenCount = overlapTokensCount;

      chunkStartLine = Math.max(0, i - overlapStartOffset);
    }

    currentChunk.push(line);
    lineTokenCounts.push(lineTokens);
    currentTokenCount += lineTokens;

    if (chunks.length >= (config.maxChunksPerFile || 1000)) {
      break;
    }
  }

  const chunkText = currentChunk.join('\n');
  if (chunkText.trim().length > MIN_CHUNK_TEXT_LENGTH) {
    chunks.push({
      text: chunkText,
      startLine: chunkStartLine + 1,
      endLine: lines.length,
      tokenCount: currentTokenCount + SPECIAL_TOKENS,
    });
  }

  return chunks;
}
