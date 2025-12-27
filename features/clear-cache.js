export class CacheClearer {
  constructor(embedder, cache, config) {
    this.cache = cache;
    this.config = config;
  }

  async execute() {
    await this.cache.clear();
    return {
      success: true,
      message: `Cache cleared successfully. Next indexing will be a full rebuild.`,
      cacheDirectory: this.config.cacheDirectory
    };
  }
}

export function getToolDefinition() {
  return {
    name: "clear_cache",
    description: "Clears the embeddings cache, forcing a complete reindex on next search or manual index operation. Useful when encountering cache corruption or after major codebase changes.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  };
}

export async function handleToolCall(request, cacheClearer) {
  try {
    const result = await cacheClearer.execute();
    return {
      content: [{
        type: "text",
        text: `${result.message}\n\nCache directory: ${result.cacheDirectory}`
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Failed to clear cache: ${error.message}`
      }]
    };
  }
}
