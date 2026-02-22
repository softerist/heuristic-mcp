import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

process.env.SMART_CODING_UNLOAD_MODEL_AFTER_SEARCH = 'false';

const EXAMPLE_JS = `export function alpha() {
  const hint = 'MCP_SEARCH_UNIQUE_TOKEN_12345';
  return hint;
}

export function beta() {
  return 'other content';
}
`;

const CONFIG_JSONC = `{
  "searchDirectory": ".",
  "enableCache": false,
  "watchFiles": false,
  "smartIndexing": false,
  "annEnabled": false,
  "preloadEmbeddingModel": false,
  "callGraphEnabled": false,
  "chunkSize": 4,
  "chunkOverlap": 0,
  "maxResults": 3,
}
`;

describe('mcp client search', () => {
  let client;
  let clientTransport;
  let serverTransport;
  let workspaceDir;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heuristic-mcp-search-'));
    await fs.writeFile(path.join(workspaceDir, 'example.js'), EXAMPLE_JS);
    await fs.writeFile(path.join(workspaceDir, 'config.jsonc'), CONFIG_JSONC);

    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {
        constructor() {
          return serverTransport;
        }
      },
    }));

    vi.doMock('@huggingface/transformers', () => {
      const pipeline = vi.fn(async () => {
        return () => ({
          data: new Float32Array([1, 0, 0]),
        });
      });

      return {
        pipeline,
        env: {
          backends: {
            onnx: {
              wasm: { numThreads: 1 },
            },
          },
        },
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
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('indexes and searches via MCP tool', async () => {
    const indexResponse = await client.callTool({
      name: 'b_index_codebase',
      arguments: { force: true },
    });

    const indexText = indexResponse.content?.[0]?.text ?? '';
    expect(indexText).toContain('Codebase reindexed successfully');

    const searchResponse = await client.callTool({
      name: 'a_semantic_search',
      arguments: { query: 'MCP_SEARCH_UNIQUE_TOKEN_12345', maxResults: 3 },
    });

    const searchText = searchResponse.content?.[0]?.text ?? '';
    expect(searchText).toContain('Result 1');
    expect(searchText).toContain('example.js');
    expect(searchText).toContain('MCP_SEARCH_UNIQUE_TOKEN_12345');
  });
});
