import crypto from "crypto";
import path from "path";

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Generate hash for file content to detect changes
 */
export function hashContent(content) {
  return crypto.createHash("md5").update(content).digest("hex");
}

/**
 * Intelligent chunking: tries to split by function/class boundaries
 */
export function smartChunk(content, file, config) {
  const lines = content.split("\n");
  const chunks = [];
  const ext = path.extname(file);
  
  // Language-specific patterns for function/class detection
  const patterns = {
    js: /^(export\s+)?(async\s+)?(function|class|const|let|var)\s+\w+/,
    ts: /^(export\s+)?(async\s+)?(function|class|const|let|var|interface|type)\s+\w+/,
    py: /^(class|def)\s+\w+/,
    java: /^(public|private|protected)?\s*(static\s+)?(class|interface|void|int|String|boolean)\s+\w+/,
    go: /^func\s+\w+/,
    rs: /^(pub\s+)?(fn|struct|enum|trait|impl)\s+\w+/,
  };

  const langPattern = patterns[ext.slice(1)] || patterns.js;
  let currentChunk = [];
  let chunkStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    currentChunk.push(line);

    // Check if we should start a new chunk
    const shouldSplit = 
      langPattern.test(line.trim()) && 
      currentChunk.length > config.chunkSize * 0.5;

    if (shouldSplit || currentChunk.length >= config.chunkSize + config.chunkOverlap) {
      if (currentChunk.join("\n").trim().length > 20) {
        chunks.push({
          text: currentChunk.join("\n"),
          startLine: chunkStartLine + 1,
          endLine: i + 1
        });
      }
      
      // Keep overlap
      currentChunk = currentChunk.slice(-config.chunkOverlap);
      chunkStartLine = i - config.chunkOverlap + 1;
    }
  }

  // Add remaining chunk
  if (currentChunk.length > 0 && currentChunk.join("\n").trim().length > 20) {
    chunks.push({
      text: currentChunk.join("\n"),
      startLine: chunkStartLine + 1,
      endLine: lines.length
    });
  }

  return chunks;
}
