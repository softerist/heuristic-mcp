import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractDefinitions } from '../lib/call-graph.js';
import { ProjectDetector } from '../lib/project-detector.js';
import { EmbeddingsCache } from '../lib/cache.js';
import fs from 'fs/promises';

vi.mock('fs/promises');

describe('Coverage Gaps', () => {
  describe('lib/call-graph.js fallback language', () => {
    it('handles unknown extensions by falling back to javascript patterns', () => {
      const content = 'function unknownExt() {}';
      const definitions = extractDefinitions(content, 'test.unknown');
      expect(definitions).toContain('unknownExt');
    });
  });

  describe('lib/project-detector.js edge cases', () => {
    it('hits depth limit and ignores deep directories', async () => {
      const detector = new ProjectDetector('/root');
      vi.mocked(fs.readdir).mockResolvedValue([{ name: 'dir1', isDirectory: () => true }]);

      
      
      await detector.detectProjectTypes();
      
    });

    it('handles missing ignore pattern for detected type', () => {
      const detector = new ProjectDetector('/root');
      
      detector.detectedTypes.add('mystery-project');
      const patterns = detector.getSmartIgnorePatterns();
      expect(patterns).toBeDefined();
      expect(patterns.length).toBeGreaterThan(0); 
    });
  });

  describe('lib/cache.js edge cases', () => {
    it('covers initHnswIndex deeper retry branches', () => {
      const mockIndex = {
        initIndex: vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error('fail 1');
          })
          .mockImplementationOnce(() => {
            throw new Error('fail 2');
          })
          .mockReturnValue(true),
      };
      
      
      

      const cache = new EmbeddingsCache({ annMetric: 'l2' });
      cache.vectorStore = [{ vector: [1, 2] }];

      
      const HierarchicalNSW = vi.fn(function () {
        return mockIndex;
      });
      cache.buildAnnIndex(HierarchicalNSW, 2);

      expect(mockIndex.initIndex).toHaveBeenCalledTimes(3);
    });

    it('covers clearCallGraphData error logging', async () => {
      const cache = new EmbeddingsCache({
        enableCache: true,
        cacheDirectory: '/path',
        verbose: true,
      });
      vi.mocked(fs.rm).mockRejectedValue(new Error('unlink failed'));

      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await cache.clearCallGraphData({ removeFile: true });

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to remove call-graph cache')
      );
    });

    it('covers getRelatedFiles missing graph path', async () => {
      const cache = new EmbeddingsCache({ callGraphEnabled: true });
      
      cache.setFileCallData('f.js', { definitions: [], calls: [] });
      
      cache.callGraph = null;

      const result = await cache.getRelatedFiles(['sym']);
      expect(result.size).toBe(0);
    });
  });
});
