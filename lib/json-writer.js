import fs from 'fs';
import { Transform } from 'stream';

/**
 * Enhanced JSON writer that streams data to disk to avoid creating
 * massive strings in memory.
 */
export class StreamingJsonWriter {
  constructor(filePath) {
    this.filePath = filePath;
    this.writer = fs.createWriteStream(filePath, { encoding: 'utf-8' });
    this.started = false;
    this.firstItem = true;
    
    // Handle write errors
    this.writer.on('error', (err) => {
      console.error(`[JsonWriter] Stream error for ${filePath}: ${err.message}`);
    });
  }

  writeStart() {
    if (this.started) return;
    this.writer.write('[\n');
    this.started = true;
  }

  // Optimized write for vector store items
  writeItem(item) {
    if (!this.started) this.writeStart();
    
    // Manual comma handling
    const prefix = this.firstItem ? '  ' : ',\n  ';
    this.firstItem = false;
    
    // Manual serialization is often faster than JSON.stringify for known structures
    // giving us fine-grained control over Float32Array handling
    let json;
    
    // Optimized path for vector chunks
    if (item && item.vector instanceof Float32Array) {
      // Manual serialization of the object to avoid converting Float32Array to huge generic arrays first
      // This is a significant optimization for the vector store
      const vectorStr = `[${item.vector.join(',')}]`;
      
      // Construct JSON manually avoiding recursion
      json = `{
    "file": ${JSON.stringify(item.file)},
    "startLine": ${item.startLine},
    "endLine": ${item.endLine},
    "content": ${JSON.stringify(item.content)},
    "vector": ${vectorStr}
  }`;
    } else {
      // Fallback for generic objects
      json = JSON.stringify(item, (_key, value) => {
        if (value instanceof Float32Array) {
          return Array.from(value);
        }
        return value;
      });
    }

    return this.writer.write(prefix + json);
  }

  writeEnd() {
    return new Promise((resolve, reject) => {
      if (!this.started) this.writeStart();
      
      this.writer.write('\n]\n', () => {
        this.writer.end(() => resolve());
      });
      
      this.writer.once('error', reject);
    });
  }
}
