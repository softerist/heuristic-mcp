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
        missing.push(file);
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
    console.error(`[Search] Query: "${query}"`);
    const queryEmbed = await this.embedder(query, {
      pooling: 'mean',
      normalize: true,
    });
    const queryVector = Array.from(queryEmbed.data);
    const queryVectorTyped = queryEmbed.data;

    let candidates = vectorStore;
    let usedAnn = false;
    if (this.config.annEnabled) {
      const candidateCount = this.getAnnCandidateCount(maxResults, vectorStore.length);
      const annLabels = await this.cache.queryAnn(queryVectorTyped, candidateCount);
      if (annLabels && annLabels.length >= maxResults) {
        usedAnn = true;
        console.error(`[Search] Using ANN index (${annLabels.length} candidates)`);
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
      console.error(`[Search] Using full scan (${vectorStore.length} chunks)`);
    }

    if (usedAnn && candidates.length < maxResults) {
      candidates = vectorStore;
      usedAnn = false;
    }

    const lowerQuery = query.toLowerCase();
    if (usedAnn && lowerQuery.length > 1) {
      let exactMatchCount = 0;
      for (const chunk of candidates) {
        if (chunk.content?.toLowerCase().includes(lowerQuery)) {
          exactMatchCount++;
        }
      }

      if (exactMatchCount < maxResults) {
        const seen = new Set(
          candidates.map((chunk) => `${chunk.file}:${chunk.startLine}:${chunk.endLine}`)
        );
        for (const chunk of vectorStore) {
          const content = chunk.content?.toLowerCase() || '';
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

    if (this.config.recencyBoost > 0) {
      // optimization: avoid IO storm during full scan fallbacks
      // Only check recency on demand if we have a reasonable number of candidates
      if (candidates.length <= 1000) {
        await this.populateFileModTimes(candidates.map((chunk) => chunk.file));
      } else {
         // for large sets, relied on cached times only (or 0 if missing)
         // this prevents blocking the search request with thousands of fs.stat calls
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
        let score = dotSimilarity(queryVector, chunk.vector) * this.config.semanticWeight;

        // Exact match boost
        const lowerContent = chunk.content?.toLowerCase() || '';

        if (lowerContent && lowerContent.includes(lowerQuery)) {
          score += this.config.exactMatchBoost;
        } else if (lowerContent) {
          // Partial word matching
          const queryWords = lowerQuery.split(/\s+/);
          const matchedWords = queryWords.filter(
            (word) => word.length > 2 && lowerContent.includes(word)
          ).length;
          score += (matchedWords / queryWords.length) * 0.3;
        }

        // Recency boost - recently modified files rank higher
        if (this.config.recencyBoost > 0) {
          const mtime = this.fileModTimes.get(chunk.file);
          if (typeof mtime === 'number') {
            const daysSinceModified = (Date.now() - mtime) / (1000 * 60 * 60 * 24);
            const decayDays = this.config.recencyDecayDays || 30;

            // Linear decay: full boost at 0 days, no boost after decayDays
            const recencyScore = Math.max(0, 1 - daysSinceModified / decayDays);
            score += recencyScore * this.config.recencyBoost;
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
        const symbols = extractSymbolsFromContent(scoredChunks[i].content);
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
    const results = scoredChunks.slice(0, maxResults);

    if (results.length > 0) {
      console.error(`[Search] Found ${results.length} results. Top score: ${results[0].score.toFixed(4)}`);
    } else {
      console.error('[Search] No results found.');
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
        return (
          `## Result ${idx + 1} (Relevance: ${(r.score * 100).toFixed(1)}%)\n` +
          `**File:** \`${relPath}\`\n` +
          `**Lines:** ${r.startLine}-${r.endLine}\n\n` +
          '```' +
          path.extname(r.file).slice(1) +
          '\n' +
          r.content +
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
