import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnConfigTool, getToolDefinition, handleToolCall } from '../features/ann-config.js';

describe('AnnConfigTool', () => {
  let cache;
  let config;

  beforeEach(() => {
    cache = {
      getAnnStats: vi.fn(),
      setEfSearch: vi.fn(),
      invalidateAnnIndex: vi.fn(),
      ensureAnnIndex: vi.fn(),
    };
    config = {};
  });

  it('returns stats by default', async () => {
    const stats = {
      enabled: true,
      indexLoaded: false,
      dirty: false,
      vectorCount: 0,
      minChunksForAnn: 10,
    };
    cache.getAnnStats.mockReturnValue(stats);
    const tool = new AnnConfigTool(cache, config);

    const result = await tool.execute({});

    expect(result).toEqual(stats);
    expect(cache.getAnnStats).toHaveBeenCalled();
  });

  it('validates set_ef_search arguments', async () => {
    const tool = new AnnConfigTool(cache, config);

    const result = await tool.execute({ action: 'set_ef_search' });

    expect(result).toEqual({
      success: false,
      error: 'efSearch parameter is required for set_ef_search action',
    });
  });

  it('sets efSearch when provided', async () => {
    cache.setEfSearch.mockResolvedValue({ success: true });
    const tool = new AnnConfigTool(cache, config);

    const result = await tool.execute({
      action: 'set_ef_search',
      efSearch: 64,
    });

    expect(cache.setEfSearch).toHaveBeenCalledWith(64);
    expect(result).toEqual({ success: true });
  });

  it('rebuilds ANN index and reports success', async () => {
    cache.ensureAnnIndex.mockResolvedValue({ ok: true });
    const tool = new AnnConfigTool(cache, config);

    const result = await tool.execute({ action: 'rebuild' });

    expect(cache.invalidateAnnIndex).toHaveBeenCalled();
    expect(cache.ensureAnnIndex).toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      message: 'ANN index rebuilt successfully',
    });
  });

  it('reports rebuild failure when index is unavailable', async () => {
    cache.ensureAnnIndex.mockResolvedValue(null);
    const tool = new AnnConfigTool(cache, config);

    const result = await tool.execute({ action: 'rebuild' });

    expect(result).toEqual({
      success: false,
      message: 'ANN index rebuild failed or not available',
    });
  });

  it('handles unknown actions', async () => {
    const tool = new AnnConfigTool(cache, config);

    const result = await tool.execute({ action: 'mystery' });

    expect(result).toEqual({
      success: false,
      error: 'Unknown action: mystery. Valid actions: stats, set_ef_search, rebuild',
    });
  });

  it('formats error results', () => {
    const tool = new AnnConfigTool(cache, config);

    const formatted = tool.formatResults({ success: false, error: 'boom' });

    expect(formatted).toBe('Error: boom');
  });

  it('formats stats results with config', () => {
    const tool = new AnnConfigTool(cache, config);
    const formatted = tool.formatResults({
      enabled: true,
      indexLoaded: true,
      dirty: false,
      vectorCount: 2,
      minChunksForAnn: 3,
      config: {
        metric: 'l2',
        dim: 2,
        count: 2,
        m: 16,
        efConstruction: 100,
        efSearch: 64,
      },
    });

    expect(formatted).toContain('ANN Index Statistics');
    expect(formatted).toContain('Current Config');
    expect(formatted).toContain('efSearch');
  });

  it('formats stats results without active config', () => {
    const tool = new AnnConfigTool(cache, config);
    const formatted = tool.formatResults({
      enabled: true,
      indexLoaded: false,
      dirty: true,
      vectorCount: 0,
      minChunksForAnn: 1,
      config: null,
    });

    expect(formatted).toContain('No active ANN index');
  });

  it('formats generic results as JSON', () => {
    const tool = new AnnConfigTool(cache, config);
    const formatted = tool.formatResults({ success: true, message: 'ok' });

    expect(formatted).toBe(JSON.stringify({ success: true, message: 'ok' }, null, 2));
  });

  it('handles tool calls end-to-end', async () => {
    cache.getAnnStats.mockReturnValue({
      enabled: false,
      indexLoaded: false,
      dirty: false,
      vectorCount: 0,
      minChunksForAnn: 1,
    });
    const tool = new AnnConfigTool(cache, config);
    const request = { params: { arguments: {} } };

    const response = await handleToolCall(request, tool);

    expect(response.content[0].text).toContain('ANN Index Statistics');
  });

  it('defaults missing tool arguments', async () => {
    cache.getAnnStats.mockReturnValue({
      enabled: true,
      indexLoaded: false,
      dirty: false,
      vectorCount: 0,
      minChunksForAnn: 1,
    });
    const tool = new AnnConfigTool(cache, config);
    const request = { params: {} };

    const response = await handleToolCall(request, tool);

    expect(response.content[0].text).toContain('ANN Index Statistics');
  });
});

