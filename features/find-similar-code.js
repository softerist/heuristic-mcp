import path from 'path';
import { dotSimilarity } from '../lib/utils.js';

/**
 * FindSimilarCode feature
 * Given a code snippet, finds similar patterns elsewhere in the codebase
 */
export class FindSimilarCode {
  constructor(embedder, cache, config) {
    this.embedder = embedder;
    this.cache = cache;
    this.config = config;
  }

  getAnnCandidateCount(maxResults, totalChunks) {
    const minCandidates = this.config.annMinCandidates ?? 0;
    const maxCandidates = this.config.annMaxCandidates ?? totalChunks;
    const multiplier = this.config.annCandidateMultiplier ?? 1;
    const desired = Math.max(minCandidates, Math.ceil(maxResults * multiplier));
    const capped = Math.min(maxCandidates, desired);
    return Math.min(totalChunks, Math.max(maxResults, capped));
  }

  async execute({ code, maxResults = 5, minSimilarity = 0.3 }) {
    const vectorStore = this.cache.getVectorStore();

    if (vectorStore.length === 0) {
      return {
        results: [],
        message: 'No code has been indexed yet. Please wait for initial indexing to complete.',
      };
    }

    // Generate embedding for the input code
    const codeEmbed = await this.embedder(code, {
      pooling: 'mean',
      normalize: true,
    });
    const codeVector = Array.from(codeEmbed.data);
    const codeVectorTyped = codeEmbed.data;

    let candidates = vectorStore;
    let usedAnn = false;
    if (this.config.annEnabled) {
      const candidateCount = this.getAnnCandidateCount(maxResults, vectorStore.length);
      const annLabels = await this.cache.queryAnn(codeVectorTyped, candidateCount);
      if (annLabels && annLabels.length >= maxResults) {
        usedAnn = true;
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

    // Score all chunks by similarity
    let scoredChunks = candidates.map((chunk) => {
      const similarity = dotSimilarity(codeVector, chunk.vector);
      return { ...chunk, similarity };
    });

    // Filter by minimum similarity and sort
    let filteredResults = scoredChunks
      .filter((chunk) => chunk.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity);

    if (usedAnn && filteredResults.length < maxResults) {
      scoredChunks = vectorStore.map((chunk) => {
        const similarity = dotSimilarity(codeVector, chunk.vector);
        return { ...chunk, similarity };
      });
      filteredResults = scoredChunks
        .filter((chunk) => chunk.similarity >= minSimilarity)
        .sort((a, b) => b.similarity - a.similarity);
    }

    // Deduplicate: if input code is from indexed file, skip exact matches
    const normalizedInput = code.trim().replace(/\s+/g, ' ');
    const results = filteredResults
      .filter((chunk) => {
        const normalizedChunk = chunk.content.trim().replace(/\s+/g, ' ');
        // Skip if it's essentially the same code (>95% similar text)
        return normalizedChunk !== normalizedInput;
      })
      .slice(0, maxResults);

    return {
      results,
      message:
        results.length === 0 ? 'No similar code found above the similarity threshold.' : null,
    };
  }

  formatResults(results) {
    if (results.length === 0) {
      return 'No similar code patterns found in the codebase.';
    }

    return results
      .map((r, idx) => {
        const relPath = path.relative(this.config.searchDirectory, r.file);
        return (
          `## Similar Code ${idx + 1} (Similarity: ${(r.similarity * 100).toFixed(1)}%)\n` +
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

// MCP Tool definition
export function getToolDefinition(_config) {
  return {
    name: 'd_find_similar_code',
    description:
      'Find similar code patterns in the codebase. Given a code snippet, returns other code chunks that are semantically similar. Useful for finding duplicate code, understanding patterns, and refactoring opportunities.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The code snippet to find similar patterns for',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of similar code chunks to return (default: 5)',
          default: 5,
        },
        minSimilarity: {
          type: 'number',
          description: 'Minimum similarity threshold 0-1 (default: 0.3 = 30%)',
          default: 0.3,
        },
      },
      required: ['code'],
    },
    annotations: {
      title: 'Find Similar Code',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

// Tool handler
export async function handleToolCall(request, findSimilarCode) {
  const code = request.params.arguments.code;
  const maxResults = request.params.arguments.maxResults || 5;
  const minSimilarity = request.params.arguments.minSimilarity || 0.3;

  const { results, message } = await findSimilarCode.execute({
    code,
    maxResults,
    minSimilarity,
  });

  if (message) {
    return {
      content: [{ type: 'text', text: message }],
    };
  }

  const formattedText = findSimilarCode.formatResults(results);

  return {
    content: [{ type: 'text', text: formattedText }],
  };
}
