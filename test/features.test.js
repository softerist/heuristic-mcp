import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as annConfig from '../features/ann-config.js';
import * as findSimilar from '../features/find-similar-code.js';

describe('Features Coverage Maximizer', () => {
  describe('ann-config.js', () => {
    it('covers tool definition and handleToolCall actions', async () => {
      expect(annConfig.getToolDefinition()).toBeDefined();

      const mockCache = {
        getAnnStats: () => ({
          enabled: true,
          indexLoaded: true,
          dirty: false,
          vectorCount: 10,
          minChunksForAnn: 5000,
          config: {
            metric: 'l2',
            dim: 128,
            count: 10,
            m: 16,
            efConstruction: 200,
            efSearch: 50,
          },
        }),
        setEfSearch: vi.fn().mockReturnValue({ success: true }),
        invalidateAnnIndex: vi.fn(),
        ensureAnnIndex: vi.fn().mockResolvedValue({}),
      };

      const tool = new annConfig.AnnConfigTool(mockCache, {});

      
      const r1 = await annConfig.handleToolCall(
        { params: { arguments: { action: 'stats' } } },
        tool
      );
      expect(r1.content[0].text).toContain('ANN Index Statistics');

      
      const r2 = await annConfig.handleToolCall(
        { params: { arguments: { action: 'set_ef_search', efSearch: 100 } } },
        tool
      );
      expect(r2.content[0].text).toContain('true');

      
      const r3 = await annConfig.handleToolCall(
        { params: { arguments: { action: 'rebuild' } } },
        tool
      );
      expect(r3.content[0].text).toContain('true');

      
      const r4 = await tool.execute({ action: 'unknown' });
      expect(r4.success).toBe(false);
      expect(tool.formatResults(r4)).toContain('Error');

      
      const r5 = await tool.execute({ action: 'set_ef_search' });
      expect(r5.success).toBe(false);

      
      const r6 = tool.formatResults({
        enabled: true,
        indexLoaded: false,
        config: null,
      });
      expect(r6).toContain('No active ANN index');
    });
  });

  describe('find-similar-code.js', () => {
    it('covers tool definition and handleToolCall search', async () => {
      expect(findSimilar.getToolDefinition({})).toBeDefined();

      const mockCache = {
        getVectorStore: () => [
          {
            file: 'a.js',
            content: 'test code line',
            vector: [1, 0],
            startLine: 1,
            endLine: 1,
          },
        ],
        queryAnn: vi.fn().mockResolvedValue([0]),
        getChunkVector: (c) => c.vector,
        getChunkContent: (c) => c.content,
      };

      const mockEmbedder = vi.fn().mockResolvedValue({ data: new Float32Array([1, 0]) });
      const tool = new findSimilar.FindSimilarCode(mockEmbedder, mockCache, {
        annEnabled: true,
        searchDirectory: '/root',
      });

      const request = {
        params: {
          arguments: {
            code: 'different search',
            maxResults: 1,
            minSimilarity: 0.1,
          },
        },
      };
      const result = await findSimilar.handleToolCall(request, tool);
      if (!result.content[0].text.includes('Similar Code')) {
        console.info('DEBUG [features]: Result text:', result.content[0].text);
      }
      expect(result.content[0].text).toContain('Similar Code');
    });

    it('handles search with no results', async () => {
      const mockCache = {
        getVectorStore: () => [],
        queryAnn: vi.fn().mockResolvedValue([]),
        getChunkVector: (c) => c.vector,
        getChunkContent: (c) => c.content,
      };
      const mockEmbedder = vi.fn().mockResolvedValue({ data: [0.1] });
      const tool = new findSimilar.FindSimilarCode(mockEmbedder, mockCache, {
        searchDirectory: '/root',
      });

      const result = await findSimilar.handleToolCall(
        { params: { arguments: { code: 'x' } } },
        tool
      );
      expect(result.content[0].text).toContain('No code has been indexed yet');

      
      tool.config.annEnabled = false;
      mockCache.getVectorStore = () => [{ file: 'a.js', content: 'y', vector: [0, 1] }]; 
      const r3 = await tool.execute({ code: 'z', minSimilarity: 0.9 });
      await expect(tool.formatResults(r3.results)).resolves.toContain(
        'No similar code patterns found'
      );
    });
  });
});
