import path from 'path';
import { dotSimilarity, smartChunk, estimateTokens, getModelTokenLimit } from '../lib/utils.js';

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

  async getChunkContent(chunk) {
    return this.cache.getChunkContent(chunk);
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

  async execute({ code, maxResults = 5, minSimilarity = 0.3 }) {
    if (typeof this.cache.ensureLoaded === 'function') {
      await this.cache.ensureLoaded();
    }
    const vectorStore = this.cache.getVectorStore();

    if (vectorStore.length === 0) {
      return {
        results: [],
        message: 'No code has been indexed yet. Please wait for initial indexing to complete.',
      };
    }

    let codeToEmbed = code;
    let warningMessage = null;

    // Check if input is too large and truncate intelligently
    const estimatedTokens = estimateTokens(code);
    const limit = getModelTokenLimit(this.config.embeddingModel);

    // If input is significantly larger than the model limit, we should chunk it
    if (estimatedTokens > limit) {
      // Use smartChunk to get a semantically valid first block
      // We pass a dummy file name to trigger language detection if possible, or default to .txt
      // Since we don't know the language, we'll try to guess or just use generic chunking
      const chunks = smartChunk(code, 'input.txt', this.config);
      if (chunks.length > 0) {
        codeToEmbed = chunks[0].text;
        warningMessage = `Note: Input code was too long (${estimatedTokens} tokens). Searching using the first chunk (${chunks[0].tokenCount} tokens).`;
      }
    }

    // Generate embedding for the input code
    const codeEmbed = await this.embedder(codeToEmbed, {
      pooling: 'mean',
      normalize: true,
    });
    const codeVector = codeEmbed.data; // Keep as Float32Array for performance
    const codeVectorTyped = codeVector;

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

    const normalizedInput = codeToEmbed.trim().replace(/\s+/g, ' ');

    /**
     * Batch scoring function to prevent blocking the event loop
     */
    const scoreAndFilter = async (chunks) => {
      const BATCH_SIZE = 500;
      const scored = [];

      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);

        // Yield to event loop between batches
        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        for (const chunk of batch) {
          const vector = this.getChunkVector(chunk);
          if (!vector) continue;
          const similarity = dotSimilarity(codeVector, vector);

          if (similarity >= minSimilarity) {
            // Deduplicate against input
            if (normalizedInput) {
              const content = await this.getChunkContent(chunk);
              const normalizedChunk = content.trim().replace(/\s+/g, ' ');
              if (normalizedChunk === normalizedInput) continue;
            }

            scored.push({ ...chunk, similarity });
          }
        }
      }

      return scored.sort((a, b) => b.similarity - a.similarity);
    };

    let filteredResults = await scoreAndFilter(candidates);

    // Fallback to full scan if ANN didn't provide enough results
    // Optimization: Skip full scan on large codebases to avoid long pauses
    const MAX_FULL_SCAN_SIZE = 5000;
    if (usedAnn && filteredResults.length < maxResults) {
      if (vectorStore.length <= MAX_FULL_SCAN_SIZE) {
        filteredResults = await scoreAndFilter(vectorStore);
      } else {
        // Just return what we found via ANN
      }
    }
    const results = await Promise.all(
      filteredResults.slice(0, maxResults).map(async (chunk) => {
        if (chunk.content === undefined || chunk.content === null) {
          return { ...chunk, content: await this.getChunkContent(chunk) };
        }
        return chunk;
      })
    );

    return {
      results,
      message:
        warningMessage ||
        (results.length === 0 ? 'No similar code found above the similarity threshold.' : null),
    };
  }

  async formatResults(results) {
    if (results.length === 0) {
      return 'No similar code patterns found in the codebase.';
    }

    const formatted = await Promise.all(
      results.map(async (r, idx) => {
        const relPath = path.relative(this.config.searchDirectory, r.file);
        const content = r.content ?? (await this.getChunkContent(r));
        return (
          `## Similar Code ${idx + 1} (Similarity: ${(r.similarity * 100).toFixed(1)}%)\n` +
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

  const formattedText = await findSimilarCode.formatResults(results);

  return {
    content: [{ type: 'text', text: formattedText }],
  };
}
