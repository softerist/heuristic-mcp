export class CacheClearer {
  constructor(embedder, cache, config, indexer) {
    this.cache = cache;
    this.config = config;
    this.indexer = indexer;
    this.isClearing = false;
  }

  async execute() {
    // Check if indexing is in progress
    if (this.indexer && this.indexer.isIndexing) {
      throw new Error(
        'Cannot clear cache while indexing is in progress. Please wait for indexing to complete.'
      );
    }

    // Check if cache is currently being saved (race condition prevention)
    if (this.cache.isSaving) {
      throw new Error(
        'Cannot clear cache while cache is being saved. Please try again in a moment.'
      );
    }

    // Check if a clear operation is already in progress (prevent concurrent clears)
    if (this.isClearing) {
      throw new Error('Cache clear operation already in progress. Please wait for it to complete.');
    }

    this.isClearing = true;

    try {
      await this.cache.clear();
      return {
        success: true,
        message: `Cache cleared successfully. Next indexing will be a full rebuild.`,
        cacheDirectory: this.config.cacheDirectory,
      };
    } finally {
      this.isClearing = false;
    }
  }
}

export function getToolDefinition() {
  return {
    name: 'c_clear_cache',
    description:
      'Clears the embeddings cache, forcing a complete reindex on next search or manual index operation. Useful when encountering cache corruption or after major codebase changes.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    annotations: {
      title: 'Clear Embeddings Cache',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

export async function handleToolCall(request, cacheClearer) {
  try {
    const result = await cacheClearer.execute();
    return {
      content: [
        {
          type: 'text',
          text: `${result.message}\n\nCache directory: ${result.cacheDirectory}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Failed to clear cache: ${error.message}`,
        },
      ],
    };
  }
}
