import path from 'path';
import fs from 'fs/promises';
import { dotSimilarity } from '../lib/utils.js';
import { extractSymbolsFromContent } from '../lib/call-graph.js';
import { embedQueryInChildProcess } from '../lib/embed-query-process.js';
import {
  STAT_CONCURRENCY_LIMIT,
  SEARCH_BATCH_SIZE,
  PARTIAL_MATCH_BOOST,
} from '../lib/constants.js';

function alignQueryVectorDimension(vector, targetDim) {
  if (!(vector instanceof Float32Array)) {
    vector = new Float32Array(vector);
  }
  if (!Number.isInteger(targetDim) || targetDim <= 0 || vector.length <= targetDim) {
    return vector;
  }

  const sliced = vector.slice(0, targetDim);
  let mag = 0;
  for (let i = 0; i < sliced.length; i += 1) mag += sliced[i] * sliced[i];
  mag = Math.sqrt(mag);
  if (mag > 0) {
    for (let i = 0; i < sliced.length; i += 1) sliced[i] /= mag;
  }
  return sliced;
}

export class HybridSearch {
  constructor(embedder, cache, config) {
    this.embedder = embedder;
    this.cache = cache;
    this.config = config;
    this.fileModTimes = new Map();
    this._lastAccess = new Map();
  }

  async getChunkContent(chunkOrIndex) {
    return await this.cache.getChunkContent(chunkOrIndex);
  }

  getChunkVector(chunk) {
    return this.cache.getChunkVector(chunk);
  }

  getAnnCandidateCount(maxResults, totalChunks) {
    const minCandidates = this.config.annMinCandidates ?? 0;
    const maxCandidates = this.config.annMaxCandidates ?? totalChunks;
    const multiplier = this.config.annCandidateMultiplier ?? 1;
    const desired = Math.max(minCandidates, Math.ceil(maxResults * multiplier));
    const capped = Math.min(maxCandidates, desired);
    return Math.min(totalChunks, Math.max(maxResults, capped));
  }

  async populateFileModTimes(files) {
    const uniqueFiles = new Set(files);
    const missing = [];

    for (const file of uniqueFiles) {
      if (!this.fileModTimes.has(file)) {
        const meta = this.cache.getFileMeta(file);
        if (meta && typeof meta.mtimeMs === 'number') {
          this.fileModTimes.set(file, meta.mtimeMs);
          this._lastAccess.set(file, Date.now());
        } else {
          missing.push(file);
        }
      } else {
        this._lastAccess.set(file, Date.now());
      }
    }

    if (missing.length === 0) {
      return;
    }

    const workerCount = Math.min(STAT_CONCURRENCY_LIMIT, missing.length);

    const worker = async (startIdx) => {
      for (let i = startIdx; i < missing.length; i += workerCount) {
        const file = missing[i];
        try {
          const stats = await fs.stat(file);
          this.fileModTimes.set(file, stats.mtimeMs);
          this._lastAccess.set(file, Date.now());
        } catch {
          this.fileModTimes.set(file, null);
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));

    const lruMaxEntries = this.config.lruMaxEntries ?? 5000;
    const lruTargetEntries = this.config.lruTargetEntries ?? 4000;
    if (this.fileModTimes.size > lruMaxEntries) {
      const entries = [...this.fileModTimes.keys()].map((k) => ({
        key: k,
        lastAccess: this._lastAccess?.get(k) ?? 0,
      }));
      entries.sort((a, b) => a.lastAccess - b.lastAccess);
      const toEvict = entries.slice(0, entries.length - lruTargetEntries);
      for (const { key } of toEvict) {
        this.fileModTimes.delete(key);
        this._lastAccess?.delete(key);
      }
    }
  }

  clearFileModTime(file) {
    this.fileModTimes.delete(file);
  }

  async search(query, maxResults) {
    try {
      if (typeof this.cache.ensureLoaded === 'function') {
        await this.cache.ensureLoaded();
      }
      this.cache.startRead();

      const storeSize = this.cache.getStoreSize();

      if (storeSize === 0) {
        return {
          results: [],
          message: 'No code has been indexed yet. Please wait for initial indexing to complete.',
        };
      }

      if (this.config.verbose) {
        console.info(`[Search] Query: "${query}"`);
      }

      let queryVector;

      if (this.config.unloadModelAfterSearch) {
        queryVector = await embedQueryInChildProcess(query, this.config);
      } else {
        const queryEmbed = await this.embedder(query, {
          pooling: 'mean',
          normalize: true,
        });

        try {
          queryVector = new Float32Array(queryEmbed.data);
        } finally {
          if (typeof queryEmbed.dispose === 'function') {
            try {
              queryEmbed.dispose();
            } catch {}
          }
        }
      }
      queryVector = alignQueryVectorDimension(queryVector, this.config.embeddingDimension);

      let candidateIndices = null;
      let usedAnn = false;

      if (this.config.annEnabled) {
        const candidateCount = this.getAnnCandidateCount(maxResults, storeSize);
        const annLabels = await this.cache.queryAnn(queryVector, candidateCount);
        if (annLabels && annLabels.length >= maxResults) {
          usedAnn = true;
          if (this.config.verbose) {
            console.info(`[Search] Using ANN index (${annLabels.length} candidates)`);
          }
          candidateIndices = Array.from(new Set(annLabels));
        }
      }

      if (!usedAnn) {
        if (this.config.verbose) {
          console.info(`[Search] Using full scan (${storeSize} chunks)`);
        }
      }

      if (usedAnn && candidateIndices && candidateIndices.length < maxResults) {
        if (this.config.verbose) {
          console.info(
            `[Search] ANN returned fewer results (${candidateIndices.length}) than requested (${maxResults}), augmenting with full scan...`
          );
        }
        candidateIndices = null;
        usedAnn = false;
      }

      const lowerQuery = query.toLowerCase();
      const queryWords =
        lowerQuery.length > 1 ? lowerQuery.split(/\s+/).filter((word) => word.length > 2) : [];
      const queryWordCount = queryWords.length;

      if (usedAnn && candidateIndices && lowerQuery.length > 1) {
        let exactMatchCount = 0;
        for (const index of candidateIndices) {
          const content = await this.getChunkContent(index);
          if (content && content.toLowerCase().includes(lowerQuery)) {
            exactMatchCount++;
          }
        }

        if (exactMatchCount < maxResults) {
          const MAX_FULL_SCAN_SIZE = this.config.fullScanThreshold ?? 2000;

          if (storeSize <= MAX_FULL_SCAN_SIZE) {
            const seen = new Set(candidateIndices);

            const FALLBACK_BATCH = 100;
            let additionalMatches = 0;
            const targetMatches = maxResults - exactMatchCount;

            outerLoop: for (let i = 0; i < storeSize; i += FALLBACK_BATCH) {
              if (i > 0) await new Promise((r) => setTimeout(r, 0));

              const limit = Math.min(storeSize, i + FALLBACK_BATCH);

              const batchIndices = [];
              for (let j = i; j < limit; j++) {
                if (!seen.has(j)) batchIndices.push(j);
              }

              const contents = await Promise.all(
                batchIndices.map((idx) => this.getChunkContent(idx))
              );

              for (let k = 0; k < batchIndices.length; k++) {
                const content = contents[k];
                if (content && content.toLowerCase().includes(lowerQuery)) {
                  const idx = batchIndices[k];
                  seen.add(idx);
                  candidateIndices.push(idx);
                  additionalMatches++;

                  if (additionalMatches >= targetMatches) break outerLoop;
                }
              }
            }
          } else {
            console.info(
              `[Search] Skipping full scan fallback (store size ${storeSize} > ${MAX_FULL_SCAN_SIZE})`
            );
          }
        }
      }

      let recencyBoostEnabled = this.config.recencyBoost > 0;
      let now = Date.now();
      let recencyDecayMs = (this.config.recencyDecayDays || 30) * 24 * 60 * 60 * 1000;
      let semanticWeight = this.config.semanticWeight;
      let exactMatchBoost = this.config.exactMatchBoost;
      let recencyBoost = this.config.recencyBoost;

      if (recencyBoostEnabled) {
        const candidates = candidateIndices
          ? candidateIndices.map((idx) => this.cache.getChunk(idx)).filter(Boolean)
          : Array.from({ length: storeSize }, (_, i) => this.cache.getChunk(i)).filter(Boolean);

        if (candidates.length <= 1000) {
          await this.populateFileModTimes(candidates.map((chunk) => chunk.file));
        } else {
          for (const chunk of candidates) {
            if (!this.fileModTimes.has(chunk.file)) {
              const meta = this.cache.getFileMeta(chunk.file);
              if (meta && typeof meta.mtimeMs === 'number') {
                this.fileModTimes.set(chunk.file, meta.mtimeMs);
              }
            }
          }
        }
      }

      const scoredChunks = [];

      const totalCandidates = candidateIndices ? candidateIndices.length : storeSize;
      const textMatchMaxCandidates = Number.isInteger(this.config.textMatchMaxCandidates)
        ? this.config.textMatchMaxCandidates
        : 2000;
      const shouldApplyTextMatch = lowerQuery.length > 1;
      const deferTextMatch = shouldApplyTextMatch && totalCandidates > textMatchMaxCandidates;

      for (let i = 0; i < totalCandidates; i += SEARCH_BATCH_SIZE) {
        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        const limit = Math.min(totalCandidates, i + SEARCH_BATCH_SIZE);

        for (let j = i; j < limit; j++) {
          const idx = candidateIndices ? candidateIndices[j] : j;

          const chunkInfo = this.cache.getChunk(idx);
          if (!chunkInfo) {
            continue;
          }

          const vector = this.cache.getChunkVector(chunkInfo, idx);
          if (!vector) continue;

          let score;
          try {
            score = dotSimilarity(queryVector, vector) * semanticWeight;
          } catch (err) {
            if (this.config.verbose) {
              console.warn(`[Search] ${err.message} at index ${idx}`);
            }
            continue;
          }

          let content;
          if (shouldApplyTextMatch && !deferTextMatch) {
            content = await this.getChunkContent(idx);
            const lowerContent = content ? content.toLowerCase() : '';

            if (lowerContent && lowerContent.includes(lowerQuery)) {
              score += exactMatchBoost;
            } else if (lowerContent && queryWordCount > 0) {
              let matchedWords = 0;
              for (let k = 0; k < queryWordCount; k++) {
                if (lowerContent.includes(queryWords[k])) matchedWords++;
              }
              score += (matchedWords / queryWordCount) * PARTIAL_MATCH_BOOST;
            }
          }

          if (recencyBoostEnabled) {
            const mtime = this.fileModTimes.get(chunkInfo.file);
            if (typeof mtime === 'number') {
              const ageMs = now - mtime;
              const recencyFactor = Math.max(0, 1 - ageMs / recencyDecayMs);
              score += recencyFactor * recencyBoost;
            }
          }

          const scoredChunk = { ...chunkInfo, score };
          if (content !== undefined) {
            scoredChunk.content = content;
          }
          scoredChunks.push(scoredChunk);
        }
      }

      scoredChunks.sort((a, b) => b.score - a.score);

      if (deferTextMatch) {
        const textMatchCount = Math.min(textMatchMaxCandidates, scoredChunks.length);
        for (let i = 0; i < textMatchCount; i++) {
          const chunk = scoredChunks[i];
          const content = chunk.content ?? (await this.getChunkContent(chunk));
          const lowerContent = content ? content.toLowerCase() : '';

          if (lowerContent && lowerContent.includes(lowerQuery)) {
            chunk.score += exactMatchBoost;
          } else if (lowerContent && queryWordCount > 0) {
            let matchedWords = 0;
            for (let k = 0; k < queryWordCount; k++) {
              if (lowerContent.includes(queryWords[k])) matchedWords++;
            }
            chunk.score += (matchedWords / queryWordCount) * PARTIAL_MATCH_BOOST;
          }

          if (chunk.content === undefined) {
            chunk.content = content;
          }
        }
        scoredChunks.sort((a, b) => b.score - a.score);
      }

      if (this.config.callGraphEnabled && this.config.callGraphBoost > 0) {
        const topN = Math.min(5, scoredChunks.length);
        const symbolsFromTop = new Set();
        for (let i = 0; i < topN; i++) {
          const content = await this.getChunkContent(scoredChunks[i]);
          const symbols = extractSymbolsFromContent(content || '');
          for (const sym of symbols) {
            symbolsFromTop.add(sym);
          }
        }

        if (symbolsFromTop.size > 0) {
          const relatedFiles = await this.cache.getRelatedFiles(Array.from(symbolsFromTop));

          for (const chunk of scoredChunks) {
            const proximity = relatedFiles.get(chunk.file);
            if (proximity) {
              chunk.score += proximity * this.config.callGraphBoost;
            }
          }

          scoredChunks.sort((a, b) => b.score - a.score);
        }
      }

      const results = await Promise.all(
        scoredChunks.slice(0, maxResults).map(async (chunk) => {
          if (chunk.content === undefined || chunk.content === null) {
            return { ...chunk, content: await this.getChunkContent(chunk) };
          }
          return chunk;
        })
      );

      if (results.length > 0) {
        console.info(
          `[Search] Found ${results.length} results. Top score: ${results[0].score.toFixed(4)}`
        );
      } else {
        console.info('[Search] No results found.');
      }

      return { results, message: null };
    } finally {
      this.cache.endRead();
    }
  }

  async formatResults(results) {
    if (results.length === 0) {
      return 'No matching code found for your query.';
    }

    const formatted = await Promise.all(
      results.map(async (r, idx) => {
        if (!r.file) {
          return `## Result ${idx + 1} (Relevance: ${(r.score * 100).toFixed(1)}%)\n**Error:** Missing file path\n`;
        }
        const relPath = path.relative(this.config.searchDirectory, r.file);
        const content = r.content ?? (await this.getChunkContent(r));
        return (
          `## Result ${idx + 1} (Relevance: ${(r.score * 100).toFixed(1)}%)\n` +
          `**File:** \`${relPath}\`\n` +
          `**Lines:** ${r.startLine}-${r.endLine}\n\n` +
          '```' +
          path.extname(r.file).slice(1) +
          '\n' +
          content +
          '\n' +
          '```\n'
        );
      })
    );

    return formatted.join('\n');
  }
}

export function getToolDefinition(config) {
  return {
    name: 'a_semantic_search',
    description:
      "Performs intelligent hybrid code search combining semantic understanding with exact text matching. Ideal for finding code by meaning (e.g., 'authentication logic', 'database queries') even with typos or variations. Returns the most relevant code snippets with file locations and line numbers.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            "Search query - can be natural language (e.g., 'where do we handle user login') or specific terms",
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return (default: from config)',
          default: config.maxResults,
        },
      },
      required: ['query'],
    },
    annotations: {
      title: 'Semantic Code Search',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

export async function handleToolCall(request, hybridSearch) {
  const args = request.params?.arguments || {};
  const query = args.query;

  if (typeof query !== 'string' || query.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: A non-empty query string is required.' }],
      isError: true,
    };
  }

  const maxResults =
    typeof args.maxResults === 'number' && args.maxResults > 0
      ? args.maxResults
      : hybridSearch.config.maxResults;

  const { results, message } = await hybridSearch.search(query, maxResults);

  if (message) {
    return {
      content: [{ type: 'text', text: message }],
    };
  }

  const formattedText = await hybridSearch.formatResults(results);

  return {
    content: [{ type: 'text', text: formattedText }],
  };
}
