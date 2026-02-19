import path from 'path';
import { dotSimilarity, smartChunk, estimateTokens, getModelTokenLimit } from '../lib/utils.js';

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
    if (typeof code !== 'string' || code.trim().length === 0) {
      return {
        results: [],
        message: 'Error: A non-empty code string is required.',
      };
    }
    const safeMaxResults =
      Number.isFinite(maxResults) && maxResults > 0 ? Math.floor(maxResults) : 5;
    const safeMinSimilarity = Number.isFinite(minSimilarity)
      ? Math.min(1, Math.max(0, minSimilarity))
      : 0.3;

    if (typeof this.cache.ensureLoaded === 'function') {
      await this.cache.ensureLoaded();
    }
    if (typeof this.cache.startRead === 'function') {
      this.cache.startRead();
    }

    try {
      const vectorStore = this.cache.getVectorStore();

      if (vectorStore.length === 0) {
        return {
          results: [],
          message: 'No code has been indexed yet. Please wait for initial indexing to complete.',
        };
      }

      let codeToEmbed = code;
      let warningMessage = null;

      const estimatedTokens = estimateTokens(code);
      const limit = getModelTokenLimit(this.config.embeddingModel);

      if (estimatedTokens > limit) {
        const chunks = smartChunk(code, 'input.txt', this.config);
        if (chunks.length > 0) {
          codeToEmbed = chunks[0].text;
          warningMessage = `Note: Input code was too long (${estimatedTokens} tokens). Searching using the first chunk (${chunks[0].tokenCount} tokens).`;
        }
      }

      const codeEmbed = await this.embedder(codeToEmbed, {
        pooling: 'mean',
        normalize: true,
      });

      let codeVector;
      try {
        codeVector = new Float32Array(codeEmbed.data);
      } finally {
        if (typeof codeEmbed.dispose === 'function') {
          try {
            codeEmbed.dispose();
          } catch {}
        }
      }

      let candidates = vectorStore;
      let usedAnn = false;
      if (this.config.annEnabled) {
        const candidateCount = this.getAnnCandidateCount(safeMaxResults, vectorStore.length);
        const annLabels = await this.cache.queryAnn(codeVector, candidateCount);
        if (annLabels && annLabels.length >= safeMaxResults) {
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

      const normalizeText = (text) => text.trim().replace(/\s+/g, ' ');
      const normalizedInput = normalizeText(codeToEmbed);

      const scoreAndFilter = async (chunks) => {
        const BATCH_SIZE = 500;
        const scored = [];

        for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
          const batch = chunks.slice(i, i + BATCH_SIZE);

          if (i > 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }

          for (const chunk of batch) {
            const vector = this.getChunkVector(chunk);
            if (!vector) continue;
            let similarity;
            try {
              similarity = dotSimilarity(codeVector, vector);
            } catch (err) {
              if (!warningMessage) {
                warningMessage = err?.message || 'Vector dimension mismatch.';
              }
              continue;
            }

            if (similarity >= safeMinSimilarity) {
              scored.push({ ...chunk, similarity });
            }
          }
        }

        return scored.sort((a, b) => b.similarity - a.similarity);
      };

      let filteredResults = await scoreAndFilter(candidates);

      const MAX_FULL_SCAN_SIZE = 5000;
      if (usedAnn && filteredResults.length < safeMaxResults) {
        if (vectorStore.length <= MAX_FULL_SCAN_SIZE) {
          filteredResults = await scoreAndFilter(vectorStore);
        }
      }
      const results = [];
      for (const chunk of filteredResults) {
        const content = chunk.content ?? (await this.getChunkContent(chunk));
        if (normalizedInput) {
          const normalizedChunk = normalizeText(content);
          if (normalizedChunk === normalizedInput) continue;
        }
        results.push({ ...chunk, content });
        if (results.length >= safeMaxResults) break;
      }

      return {
        results,
        message:
          warningMessage ||
          (results.length === 0 ? 'No similar code found above the similarity threshold.' : null),
      };
    } finally {
      if (typeof this.cache.endRead === 'function') {
        this.cache.endRead();
      }
    }
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

export async function handleToolCall(request, findSimilarCode) {
  const args = request.params?.arguments || {};
  const code = args.code;
  if (typeof code !== 'string' || code.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: A non-empty code string is required.' }],
      isError: true,
    };
  }
  const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 5;
  const minSimilarity = typeof args.minSimilarity === 'number' ? args.minSimilarity : 0.3;

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
