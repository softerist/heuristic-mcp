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

    // Prevent unbounded growth (simple eviction)
    if (this.fileModTimes.size > 5000) {
      for (const [key] of this.fileModTimes) {
        this.fileModTimes.delete(key);
        if (this.fileModTimes.size <= 4000) break;
      }
    }
  }

  // Cache invalidation helper
  clearFileModTime(file) {
    this.fileModTimes.delete(file);
  }

  async search(query, maxResults) {
    try {
      this.cache.startRead();
      
      const storeSize = this.cache.getStoreSize();

      if (storeSize === 0) {
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

      let candidateIndices = null; // null implies full scan of all chunks
    let usedAnn = false;

    if (this.config.annEnabled) {
      const candidateCount = this.getAnnCandidateCount(maxResults, storeSize);
      const annLabels = await this.cache.queryAnn(queryVectorTyped, candidateCount);
      if (annLabels && annLabels.length >= maxResults) {
        usedAnn = true;
        console.info(`[Search] Using ANN index (${annLabels.length} candidates)`);
        candidateIndices = Array.from(new Set(annLabels)); // dedupe
      }
    }

    if (!usedAnn) {
      console.info(`[Search] Using full scan (${storeSize} chunks)`);
    }

    if (usedAnn && candidateIndices && candidateIndices.length < maxResults) {
      candidateIndices = null; // Fallback to full scan
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
        // We can check if we should just abandon ANN or augment it.
        // Current logic: scan everything for keyword matches and ADD them.
        
        const seen = new Set(candidateIndices);
        
        // Full scan logic for keyword augmentation
        // Iterate by index
        for (let i = 0; i < storeSize; i++) {
           if (seen.has(i)) continue;
           
           // Lazy load content only if needed (this might be slow for huge repo)
           // But `getChunkContent` should use cache.
           const content = await this.getChunkContent(i);
           if (content && content.toLowerCase().includes(lowerQuery)) {
               seen.add(i);
               candidateIndices.push(i);
           }
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

    for (let i = 0; i < totalCandidates; i += BATCH_SIZE) {
      // Allow event loop to tick between batches
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const limit = Math.min(totalCandidates, i + BATCH_SIZE);
      
      for (let j = i; j < limit; j++) {
        const idx = candidateIndices ? candidateIndices[j] : j;
        
        // Lazy load keys
        const vector = this.cache.getVector(idx);
        if (!vector) continue;
        
        let score = dotSimilarity(queryVector, vector) * semanticWeight;

        // Exact match boost
        const content = await this.getChunkContent(idx);
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

        // Needs chunk info for result
        const chunkInfo = this.cache.getChunk(idx);
        
        // Recency boost
        if (recencyBoostEnabled && chunkInfo) {
              const mtime = this.fileModTimes.get(chunkInfo.file);
              if (typeof mtime === 'number') {
                const ageMs = now - mtime;
                const recencyFactor = Math.max(0, 1 - ageMs / recencyDecayMs);
                score += recencyFactor * recencyBoost;
              }
        }
        
        if (chunkInfo) {
            scoredChunks.push({ ...chunkInfo, score, content });
        }
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
    const results = await Promise.all(scoredChunks.slice(0, maxResults).map(async (chunk) => {
      if (chunk.content === undefined || chunk.content === null) {
        return { ...chunk, content: await this.getChunkContent(chunk) };
      }
      return chunk;
    }));

    if (results.length > 0) {
      console.info(`[Search] Found ${results.length} results. Top score: ${results[0].score.toFixed(4)}`);
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

    const formatted = await Promise.all(results.map(async (r, idx) => {
      const relPath = path.relative(this.config.searchDirectory, r.file);
      const content = r.content ?? await this.getChunkContent(r);
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
    }));

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
  const query = request.params.arguments.query;
  const maxResults = request.params.arguments.maxResults || hybridSearch.config.maxResults;

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
