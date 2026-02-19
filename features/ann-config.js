export class AnnConfigTool {
  constructor(cache, config) {
    this.cache = cache;
    this.config = config;
  }

  async execute(args) {
    const action = args.action || 'stats';

    if (action === 'stats') {
      return this.cache.getAnnStats();
    }

    if (action === 'set_ef_search') {
      const efSearch = args.efSearch;
      if (efSearch === undefined) {
        return {
          success: false,
          error: 'efSearch parameter is required for set_ef_search action',
        };
      }
      return this.cache.setEfSearch(efSearch);
    }

    if (action === 'rebuild') {
      try {
        this.cache.invalidateAnnIndex();
        const index = await this.cache.ensureAnnIndex();
        if (!index) {
          return {
            success: false,
            error: 'ANN index rebuild failed or not available',
          };
        }
        return {
          success: true,
          message: 'ANN index rebuilt successfully',
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return {
      success: false,
      error: `Unknown action: ${action}. Valid actions: stats, set_ef_search, rebuild`,
    };
  }

  formatResults(result) {
    if (result.success === false) {
      return `Error: ${result.error || result.message || 'Unknown error'}`;
    }

    if (result.enabled !== undefined) {
      let output = '## ANN Index Statistics\n\n';
      output += `- **Enabled**: ${result.enabled}\n`;
      output += `- **Index Loaded**: ${result.indexLoaded}\n`;
      output += `- **Dirty (needs rebuild)**: ${result.dirty}\n`;
      output += `- **Vector Count**: ${result.vectorCount}\n`;
      output += `- **Min Chunks for ANN**: ${result.minChunksForAnn}\n`;

      if (result.config) {
        output += '\n### Current Config\n\n';
        output += `- **Metric**: ${result.config.metric}\n`;
        output += `- **Dimensions**: ${result.config.dim}\n`;
        output += `- **Indexed Vectors**: ${result.config.count}\n`;
        output += `- **M (connectivity)**: ${result.config.m}\n`;
        output += `- **efConstruction**: ${result.config.efConstruction}\n`;
        output += `- **efSearch**: ${result.config.efSearch}\n`;
      } else {
        output += '\n*No active ANN index.*\n';
      }

      return output;
    }

    return JSON.stringify(result, null, 2);
  }
}

export function getToolDefinition() {
  return {
    name: 'd_ann_config',
    description:
      "Configure and monitor the ANN (Approximate Nearest Neighbor) search index. Actions: 'stats' (view current config), 'set_ef_search' (tune search accuracy/speed), 'rebuild' (force index rebuild).",
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['stats', 'set_ef_search', 'rebuild'],
          description:
            "Action to perform. 'stats' shows current config, 'set_ef_search' changes the search parameter, 'rebuild' forces index rebuild.",
          default: 'stats',
        },
        efSearch: {
          type: 'number',
          description:
            'New efSearch value (only for set_ef_search action). Higher = more accurate but slower. Typical range: 16-512.',
          minimum: 1,
          maximum: 1000,
        },
      },
    },
    annotations: {
      title: 'ANN Index Configuration',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

export async function handleToolCall(request, annConfigTool) {
  const args = request.params.arguments || {};
  const result = await annConfigTool.execute(args);
  const formattedText = annConfigTool.formatResults(result);

  return {
    content: [{ type: 'text', text: formattedText }],
  };
}
