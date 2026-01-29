import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  FindSimilarCode,
  getToolDefinition,
  handleToolCall,
} from '../features/find-similar-code.js';

const makeEmbedder = (vector) => vi.fn().mockResolvedValue({ data: Float32Array.from(vector) });

describe('FindSimilarCode', () => {
  it('returns a helpful message when the index is empty', async () => {
    const embedder = makeEmbedder([1, 0]);
    const cache = { getVectorStore: () => [], ensureLoaded: vi.fn() };
    const config = { searchDirectory: process.cwd() };
    const tool = new FindSimilarCode(embedder, cache, config);

    const result = await tool.execute({ code: 'const x = 1;' });

    expect(result.results).toEqual([]);
    expect(result.message).toMatch(/No code has been indexed/);
  });

  it('dedupes ANN candidates and falls back when too few remain', async () => {
    const embedder = makeEmbedder([1, 0]);
    const vectorStore = [
      {
        file: 'C:/repo/a.js',
        startLine: 1,
        endLine: 2,
        content: 'alpha',
        vector: [1, 0],
      },
      {
        file: 'C:/repo/b.js',
        startLine: 3,
        endLine: 4,
        content: 'beta',
        vector: [0.5, 0.5],
      },
    ];
    const cache = {
      getVectorStore: () => vectorStore,
      queryAnn: vi.fn().mockResolvedValue([0, 0]),
      getChunkVector: (chunk) => chunk.vector,
      getChunkContent: (chunk) => chunk.content,
      ensureLoaded: vi.fn(),
    };
    const config = {
      annEnabled: true,
      annCandidateMultiplier: 1,
      annMinCandidates: 0,
      annMaxCandidates: 10,
      searchDirectory: 'C:/repo',
    };
    const tool = new FindSimilarCode(embedder, cache, config);

    const result = await tool.execute({
      code: 'gamma',
      maxResults: 2,
      minSimilarity: 0,
    });

    expect(cache.queryAnn).toHaveBeenCalled();
    expect(result.results.length).toBe(2);
  });

  it('skips exact text matches against the input', async () => {
    const embedder = makeEmbedder([1, 0]);
    const vectorStore = [
      {
        file: 'C:/repo/a.js',
        startLine: 1,
        endLine: 2,
        content: 'same code',
        vector: [1, 0],
      },
      {
        file: 'C:/repo/b.js',
        startLine: 3,
        endLine: 4,
        content: 'other code',
        vector: [0, 1],
      },
    ];
    const cache = {
      getVectorStore: () => vectorStore,
      queryAnn: vi.fn().mockResolvedValue([0, 1]),
      getChunkVector: (chunk) => chunk.vector,
      getChunkContent: (chunk) => chunk.content,
      ensureLoaded: vi.fn(),
    };
    const config = { annEnabled: true, searchDirectory: 'C:/repo' };
    const tool = new FindSimilarCode(embedder, cache, config);

    const result = await tool.execute({
      code: 'same code',
      maxResults: 2,
      minSimilarity: 0,
    });

    expect(result.results.length).toBe(1);
    expect(result.results[0].content).toBe('other code');
  });

  it('handles ANN candidates that are below the minimum', async () => {
    const embedder = makeEmbedder([1, 0]);
    const vectorStore = [
      {
        file: 'C:/repo/a.js',
        startLine: 1,
        endLine: 2,
        content: 'alpha',
        vector: [1, 0],
      },
      {
        file: 'C:/repo/b.js',
        startLine: 3,
        endLine: 4,
        content: 'beta',
        vector: [0, 1],
      },
    ];
    const cache = {
      getVectorStore: () => vectorStore,
      queryAnn: vi.fn().mockResolvedValue([0]),
      getChunkVector: (chunk) => chunk.vector,
      getChunkContent: (chunk) => chunk.content,
      ensureLoaded: vi.fn(),
    };
    const config = { annEnabled: true, searchDirectory: 'C:/repo' };
    const tool = new FindSimilarCode(embedder, cache, config);

    const result = await tool.execute({
      code: 'gamma',
      maxResults: 2,
      minSimilarity: 0,
    });

    expect(result.results.length).toBe(2);
  });

  it('formats results with relative paths and code fences', async () => {
    const embedder = makeEmbedder([1, 0]);
    const cache = { getVectorStore: () => [], ensureLoaded: vi.fn() };
    const config = { searchDirectory: 'C:/repo' };
    const tool = new FindSimilarCode(embedder, cache, config);
    const results = [
      {
        file: 'C:/repo/src/example.js',
        startLine: 10,
        endLine: 12,
        content: 'const x = 1;',
        similarity: 0.9,
      },
    ];

    const formatted = await tool.formatResults(results);

    expect(formatted).toContain(path.normalize('src/example.js'));
    expect(formatted).toContain('```js');
  });

  it('returns a message when formatting empty results', async () => {
    const embedder = makeEmbedder([1, 0]);
    const cache = { getVectorStore: () => [], ensureLoaded: vi.fn() };
    const config = { searchDirectory: 'C:/repo' };
    const tool = new FindSimilarCode(embedder, cache, config);

    await expect(tool.formatResults([])).resolves.toBe('No similar code patterns found in the codebase.');
  });

  it('handles tool calls with messages', async () => {
    const embedder = makeEmbedder([1, 0]);
    const cache = { getVectorStore: () => [], ensureLoaded: vi.fn() };
    const config = { searchDirectory: 'C:/repo' };
    const tool = new FindSimilarCode(embedder, cache, config);
    const request = { params: { arguments: { code: 'x' } } };

    const response = await handleToolCall(request, tool);

    expect(response.content[0].text).toMatch(/No code has been indexed/);
  });

  it('exposes tool definition', () => {
    const definition = getToolDefinition();

    expect(definition.name).toBe('d_find_similar_code');
    expect(definition.inputSchema.required).toContain('code');
  });
});
