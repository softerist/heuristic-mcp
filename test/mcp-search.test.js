import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import path from 'path';

const workspaceDir = path.join(process.cwd(), 'test', 'fixtures', 'mcp-workspace');

describe('mcp client search', () => {
  let client;
  let clientTransport;
  let serverTransport;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {
        constructor() {
          return serverTransport;
        }
      }
    }));

    vi.doMock('@huggingface/transformers', () => {
      const pipeline = vi.fn(async () => {
        return () => ({
          data: new Float32Array([1, 0, 0])
        });
      });

      return {
        pipeline,
        env: {
          backends: {
            onnx: {
              wasm: { numThreads: 1 }
            }
          }
        }
      };
    });

    const { main } = await import('../index.js');
    await main(['node', 'index.js', '--workspace', workspaceDir]);

    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    if (client) {
      await client.close();
    }
  });

  it('indexes and searches via MCP tool', async () => {
    const indexResponse = await client.callTool({
      name: 'b_index_codebase',
      arguments: { force: true }
    });

    const indexText = indexResponse.content?.[0]?.text ?? '';
    expect(indexText).toContain('Codebase reindexed successfully');

    const searchResponse = await client.callTool({
      name: 'a_semantic_search',
      arguments: { query: 'MCP_SEARCH_UNIQUE_TOKEN_12345', maxResults: 3 }
    });

    const searchText = searchResponse.content?.[0]?.text ?? '';
    expect(searchText).toContain('Result 1');
    expect(searchText).toContain('example.js');
    expect(searchText).toContain('MCP_SEARCH_UNIQUE_TOKEN_12345');
  });
});
