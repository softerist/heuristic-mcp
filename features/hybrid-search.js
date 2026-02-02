import path from 'path';
import fs from 'fs/promises';
import { dotSimilarity } from '../lib/utils.js';
import { extractSymbolsFromContent } from '../lib/call-graph.js';

export class HybridSearch {
  constructor(embedder, cache, config) {
    this.embedder = embedder;
    this.cache = cache;
    this.config = config;
    this.fileModTimes = new Map(); // Cache for file modification times
    this._lastAccess = new Map(); // Track last access time for LRU eviction
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
        // Try to get from cache metadata first (fast)
        const meta = this.cache.getFileMeta(file);
        if (meta && typeof meta.mtimeMs === 'number') {
          this.fileModTimes.set(file, meta.mtimeMs);
          this._lastAccess.set(file, Date.now()); // Track for LRU
        } else {
          missing.push(file);
        }
      } else {
        this._lastAccess.set(file, Date.now()); // Track access for LRU
      }
    }

    if (missing.length === 0) {
      return;
    }

    // Concurrency-limited execution to avoid EMFILE
    // Pre-distribute files to workers (no shared mutable state - avoids race condition)
    const CONCURRENCY_LIMIT = 50;
    const workerCount = Math.min(CONCURRENCY_LIMIT, missing.length);

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

    // Prevent unbounded growth (LRU-style eviction based on access time)
    const lruMaxEntries = this.config.lruMaxEntries ?? 5000;
    const lruTargetEntries = this.config.lruTargetEntries ?? 4000;
    if (this.fileModTimes.size > lruMaxEntries) {
      // Convert to array with last-access info, sort by oldest access
      const entries = [...this.fileModTimes.keys()].map((k) => ({
        key: k,
        lastAccess: this._lastAccess?.get(k) ?? 0,
      }));
      entries.sort((a, b) => a.lastAccess - b.lastAccess); // Oldest first
      const toEvict = entries.slice(0, entries.length - lruTargetEntries);
      for (const { key } of toEvict) {
        this.fileModTimes.delete(key);
        this._lastAccess?.delete(key);
      }
    }
  }

  // Cache invalidation helper
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

      // Generate query embedding
      if (this.config.verbose) {
        console.info(`[Search] Query: "${query}"`);
      }
      const queryEmbed = await this.embedder(query, {
        pooling: 'mean',
        normalize: true,
      });

      let queryVector;
      try {
        queryVector = new Float32Array(queryEmbed.data);
      } finally {
        if (typeof queryEmbed.dispose === 'function') {
          try {
            queryEmbed.dispose();
          } catch {
            /* ignore */
          }
        }
      }

      let candidateIndices = null; // null implies full scan of all chunks
      let usedAnn = false;

      if (this.config.annEnabled) {
        const candidateCount = this.getAnnCandidateCount(maxResults, storeSize);
        const annLabels = await this.cache.queryAnn(queryVector, candidateCount);
        if (annLabels && annLabels.length >= maxResults) {
          usedAnn = true;
          if (this.config.verbose) {
            console.info(`[Search] Using ANN index (${annLabels.length} candidates)`);
          }
          candidateIndices = Array.from(new Set(annLabels)); // dedupe
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
        candidateIndices = null; // Fallback to full scan to ensure we don't miss anything relevant
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
          // Fallback to full scan if keyword constraint isn't met in candidates
          // Note: This is expensive as it iterates everything.
          // Optimization: Only do this for small-ish codebases to avoid UI freeze
          const MAX_FULL_SCAN_SIZE = this.config.fullScanThreshold ?? 2000;

          if (storeSize <= MAX_FULL_SCAN_SIZE) {
            const seen = new Set(candidateIndices);

            // Full scan logic for keyword augmentation
            // Iterate by index with yielding
            const FALLBACK_BATCH = 100;
            let additionalMatches = 0;
            const targetMatches = maxResults - exactMatchCount;
            
            outerLoop:
            for (let i = 0; i < storeSize; i += FALLBACK_BATCH) {
              if (i > 0) await new Promise((r) => setTimeout(r, 0)); // Yield

              const limit = Math.min(storeSize, i + FALLBACK_BATCH);
              for (let j = i; j < limit; j++) {
                if (seen.has(j)) continue;

                // Lazy load content only if needed (this might be slow for huge repo)
                // But `getChunkContent` should use cache.
                const content = await this.getChunkContent(j);
                if (content && content.toLowerCase().includes(lowerQuery)) {
                  seen.add(j);
                  candidateIndices.push(j);
                  additionalMatches++;
                  // Early exit once we have enough additional matches
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

      // Recency pre-processing
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
        // optimization: avoid IO storm during full scan fallbacks
        // For large candidate sets, we strictly rely on cached metadata
        // For small sets, we allow best-effort fs.stat
        if (candidates.length <= 1000) {
          await this.populateFileModTimes(candidates.map((chunk) => chunk.file));
        } else {
          // Bulk pre-populate from cache only (no syscalls)
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

      // Score all chunks (batched to prevent blocking event loop)
      const BATCH_SIZE = 500;
      const scoredChunks = [];

      // Process in batches
      // Candidates is now implicitly range 0..storeSize OR candidateIndices
      const totalCandidates = candidateIndices ? candidateIndices.length : storeSize;
      const textMatchMaxCandidates = Number.isInteger(this.config.textMatchMaxCandidates)
        ? this.config.textMatchMaxCandidates
        : 2000;
      const shouldApplyTextMatch = lowerQuery.length > 1;
      const deferTextMatch = shouldApplyTextMatch && totalCandidates > textMatchMaxCandidates;

      for (let i = 0; i < totalCandidates; i += BATCH_SIZE) {
        // Allow event loop to tick between batches
        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        const limit = Math.min(totalCandidates, i + BATCH_SIZE);

        for (let j = i; j < limit; j++) {
          const idx = candidateIndices ? candidateIndices[j] : j;

          // CRITICAL: Fetch chunk info FIRST to ensure atomicity with index.
          // If we fetch vector and chunk separately, the store could be modified
          // between calls (e.g., by removeFileFromStore compacting the array).
          const chunkInfo = this.cache.getChunk(idx);
          if (!chunkInfo) {
            // Chunk was removed or index is stale - skip silently
            continue;
          }

          // Get vector from chunk or via index (now safe since we have valid chunkInfo)
          const vector = this.cache.getChunkVector(chunkInfo, idx);
          if (!vector) continue;

          // Ensure vector compatibility with try-catch for dimension mismatch
          let score;
          try {
            score = dotSimilarity(queryVector, vector) * semanticWeight;
          } catch (err) {
            // Dimension mismatch indicates config change - log and skip this chunk
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
              // Partial word matching (optimized)
              let matchedWords = 0;
              for (let k = 0; k < queryWordCount; k++) {
                if (lowerContent.includes(queryWords[k])) matchedWords++;
              }
              score += (matchedWords / queryWordCount) * 0.3;
            }
          }

          // Recency boost
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

      // Sort by initial score
      scoredChunks.sort((a, b) => b.score - a.score);

      // Defer expensive text matching for large candidate sets
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
            chunk.score += (matchedWords / queryWordCount) * 0.3;
          }

          if (chunk.content === undefined) {
            chunk.content = content;
          }
        }
        scoredChunks.sort((a, b) => b.score - a.score);
      }

      // Apply call graph proximity boost if enabled
      if (this.config.callGraphEnabled && this.config.callGraphBoost > 0) {
        // Extract symbols from top initial results
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
          // Get related files from call graph
          const relatedFiles = await this.cache.getRelatedFiles(Array.from(symbolsFromTop));

          // Apply boost to chunks from related files
          for (const chunk of scoredChunks) {
            const proximity = relatedFiles.get(chunk.file);
            if (proximity) {
              chunk.score += proximity * this.config.callGraphBoost;
            }
          }
          // Re-sort after applying call graph boost
          scoredChunks.sort((a, b) => b.score - a.score);
        }
      }

      // Get top results
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

// MCP Tool definition for this feature
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

// Tool handler
export async function handleToolCall(request, hybridSearch) {
  const args = request.params?.arguments || {};
  const query = args.query;
  
  // Input validation
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
