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
  }

  getChunkContent(chunk) {
    if (this.cache?.getChunkContent) {
      return this.cache.getChunkContent(chunk);
    }
    return chunk?.content ?? '';
  }

  getChunkVector(chunk) {
    if (this.cache?.getChunkVector) {
      return this.cache.getChunkVector(chunk);
    }
    return chunk?.vector ?? null;
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
        const meta = this.cache.getFileMeta?.(file);
        if (meta && typeof meta.mtimeMs === 'number') {
          this.fileModTimes.set(file, meta.mtimeMs);
        } else {
          missing.push(file);
        }
      }
    }

    if (missing.length === 0) {
      return;
    }

    const BATCH_SIZE = 200;
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (file) => {
          try {
            const stats = await fs.stat(file);
            this.fileModTimes.set(file, stats.mtimeMs);
          } catch {
            this.fileModTimes.set(file, null);
          }
        })
      );
    }
  }

  // Cache invalidation helper
  clearFileModTime(file) {
    this.fileModTimes.delete(file);
  }

  async search(query, maxResults) {
    const vectorStore = this.cache.getVectorStore();

    if (vectorStore.length === 0) {
      return {
        results: [],
        message: 'No code has been indexed yet. Please wait for initial indexing to complete.',
      };
    }

    // Generate query embedding
    console.info(`[Search] Query: "${query}"`);
    const queryEmbed = await this.embedder(query, {
      pooling: 'mean',
      normalize: true,
    });
    const queryVector = queryEmbed.data; // Keep as Float32Array for performance
    const queryVectorTyped = queryVector;

    let candidates = vectorStore;
    let usedAnn = false;
    if (this.config.annEnabled) {
      const candidateCount = this.getAnnCandidateCount(maxResults, vectorStore.length);
      const annLabels = await this.cache.queryAnn(queryVectorTyped, candidateCount);
      if (annLabels && annLabels.length >= maxResults) {
        usedAnn = true;
        console.info(`[Search] Using ANN index (${annLabels.length} candidates)`);
        const seen = new Set();
        candidates = annLabels
          .map((index) => {
            if (seen.has(index)) return null;
            seen.add(index);
            return vectorStore[index];
          })
          .filter(Boolean);
      }
    }

    if (!usedAnn) {
      console.info(`[Search] Using full scan (${vectorStore.length} chunks)`);
    }

    if (usedAnn && candidates.length < maxResults) {
      candidates = vectorStore;
      usedAnn = false;
    }

    const lowerQuery = query.toLowerCase();
    const queryWords =
      lowerQuery.length > 1 ? lowerQuery.split(/\s+/).filter((word) => word.length > 2) : [];
    const queryWordCount = queryWords.length;

    if (usedAnn && lowerQuery.length > 1) {
      let exactMatchCount = 0;
      for (const chunk of candidates) {
        const content = this.getChunkContent(chunk);
        if (content && content.toLowerCase().includes(lowerQuery)) {
          exactMatchCount++;
        }
      }

      if (exactMatchCount < maxResults) {
        const seen = new Set(
          candidates.map((chunk) => `${chunk.file}:${chunk.startLine}:${chunk.endLine}`)
        );
        for (const chunk of vectorStore) {
          const content = this.getChunkContent(chunk).toLowerCase();
          if (!content.includes(lowerQuery)) continue;

          const key = `${chunk.file}:${chunk.startLine}:${chunk.endLine}`;
          if (seen.has(key)) {
            continue;
          }

          seen.add(key);
          candidates.push(chunk);
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
      // optimization: avoid IO storm during full scan fallbacks
      // For large candidate sets, we strictly rely on cached metadata
      // For small sets, we allow best-effort fs.stat
      if (candidates.length <= 1000) {
        await this.populateFileModTimes(candidates.map((chunk) => chunk.file));
      } else {
        // Bulk pre-populate from cache only (no syscalls)
        for (const chunk of candidates) {
          if (!this.fileModTimes.has(chunk.file)) {
            const meta = this.cache.getFileMeta?.(chunk.file);
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
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);

      // Allow event loop to tick between batches
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      for (const chunk of batch) {
        // Semantic similarity (vectors are normalized)
        const vector = this.getChunkVector(chunk);
        if (!vector) continue;
        let score = dotSimilarity(queryVector, vector) * semanticWeight;

        // Exact match boost
        const lowerContent = this.getChunkContent(chunk).toLowerCase();

        if (lowerContent && lowerContent.includes(lowerQuery)) {
          score += exactMatchBoost;
        } else if (lowerContent && queryWordCount > 0) {
          // Partial word matching (optimized)
          let matchedWords = 0;
          for (let j = 0; j < queryWordCount; j++) {
            if (lowerContent.includes(queryWords[j])) matchedWords++;
          }
          score += (matchedWords / queryWordCount) * 0.3;
        }

        // Recency boost - recently modified files rank higher
        if (recencyBoostEnabled) {
          const mtime = this.fileModTimes.get(chunk.file);
          if (typeof mtime === 'number') {
            const ageMs = now - mtime;
            // Linear decay: full boost at 0 age, 0 boost at recencyDecayMs
            const recencyFactor = Math.max(0, 1 - ageMs / recencyDecayMs);
            score += recencyFactor * recencyBoost;
          }
        }

        scoredChunks.push({ ...chunk, score });
      }
    }

    // Sort by initial score
    scoredChunks.sort((a, b) => b.score - a.score);

    // Apply call graph proximity boost if enabled
    if (this.config.callGraphEnabled && this.config.callGraphBoost > 0) {
      // Extract symbols from top initial results
      const topN = Math.min(5, scoredChunks.length);
      const symbolsFromTop = new Set();
      for (let i = 0; i < topN; i++) {
        const content = this.getChunkContent(scoredChunks[i]);
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
    const results = scoredChunks.slice(0, maxResults).map((chunk) => {
      if (chunk.content === undefined || chunk.content === null) {
        return { ...chunk, content: this.getChunkContent(chunk) };
      }
      return chunk;
    });

    if (results.length > 0) {
      console.info(`[Search] Found ${results.length} results. Top score: ${results[0].score.toFixed(4)}`);
    } else {
      console.info('[Search] No results found.');
    }

    return { results, message: null };
  }

  formatResults(results) {
    if (results.length === 0) {
      return 'No matching code found for your query.';
    }

    return results
      .map((r, idx) => {
        const relPath = path.relative(this.config.searchDirectory, r.file);
        const content = r.content ?? this.getChunkContent(r);
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
      .join('\n');
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
  const query = request.params.arguments.query;
  const maxResults = request.params.arguments.maxResults || hybridSearch.config.maxResults;

  const { results, message } = await hybridSearch.search(query, maxResults);

  if (message) {
    return {
      content: [{ type: 'text', text: message }],
    };
  }

  const formattedText = hybridSearch.formatResults(results);

  return {
    content: [{ type: 'text', text: formattedText }],
  };
}
