import fs from "fs/promises";
import path from "path";

export class EmbeddingsCache {
  constructor(config) {
    this.config = config;
    this.vectorStore = [];
    this.fileHashes = new Map();
  }

  async load() {
    if (!this.config.enableCache) return;
    
    try {
      await fs.mkdir(this.config.cacheDirectory, { recursive: true });
      const cacheFile = path.join(this.config.cacheDirectory, "embeddings.json");
      const hashFile = path.join(this.config.cacheDirectory, "file-hashes.json");
      
      const [cacheData, hashData] = await Promise.all([
        fs.readFile(cacheFile, "utf-8").catch(() => null),
        fs.readFile(hashFile, "utf-8").catch(() => null)
      ]);

      if (cacheData && hashData) {
        const rawVectorStore = JSON.parse(cacheData);
        const rawHashes = new Map(Object.entries(JSON.parse(hashData)));
        
        // Filter cache to only include files matching current extensions
        const allowedExtensions = this.config.fileExtensions.map(ext => `.${ext}`);
        
        this.vectorStore = rawVectorStore.filter(chunk => {
          const ext = path.extname(chunk.file);
          return allowedExtensions.includes(ext);
        });
        
        // Only keep hashes for files matching current extensions
        for (const [file, hash] of rawHashes) {
          const ext = path.extname(file);
          if (allowedExtensions.includes(ext)) {
            this.fileHashes.set(file, hash);
          }
        }
        
        const filtered = rawVectorStore.length - this.vectorStore.length;
        if (filtered > 0) {
          console.error(`[Cache] Filtered ${filtered} outdated cache entries`);
        }
        console.error(`[Cache] Loaded ${this.vectorStore.length} cached embeddings`);
      }
    } catch (error) {
      console.error("[Cache] Failed to load cache:", error.message);
    }
  }

  async save() {
    if (!this.config.enableCache) return;
    
    try {
      await fs.mkdir(this.config.cacheDirectory, { recursive: true });
      const cacheFile = path.join(this.config.cacheDirectory, "embeddings.json");
      const hashFile = path.join(this.config.cacheDirectory, "file-hashes.json");
      
      await Promise.all([
        fs.writeFile(cacheFile, JSON.stringify(this.vectorStore, null, 2)),
        fs.writeFile(hashFile, JSON.stringify(Object.fromEntries(this.fileHashes), null, 2))
      ]);
    } catch (error) {
      console.error("[Cache] Failed to save cache:", error.message);
    }
  }

  getVectorStore() {
    return this.vectorStore;
  }

  setVectorStore(store) {
    this.vectorStore = store;
  }

  getFileHash(file) {
    return this.fileHashes.get(file);
  }

  setFileHash(file, hash) {
    this.fileHashes.set(file, hash);
  }

  deleteFileHash(file) {
    this.fileHashes.delete(file);
  }

  removeFileFromStore(file) {
    this.vectorStore = this.vectorStore.filter(chunk => chunk.file !== file);
  }


  addToStore(chunk) {
    this.vectorStore.push(chunk);
  }

  async clear() {
    if (!this.config.enableCache) return;
    
    try {
      await fs.rm(this.config.cacheDirectory, { recursive: true, force: true });
      this.vectorStore = [];
      this.fileHashes = new Map();
      console.error(`[Cache] Cache cleared successfully: ${this.config.cacheDirectory}`);
    } catch (error) {
      console.error("[Cache] Failed to clear cache:", error.message);
      throw error;
    }
  }
}
