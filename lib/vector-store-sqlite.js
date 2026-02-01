/**
 * SQLite Vector Store
 *
 * An alternative to binary/JSON vector stores using SQLite for persistence.
 * Provides ACID transactions, simpler concurrent access, and query flexibility.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs/promises';

const SQLITE_FILE = 'vectors.sqlite';
const STORE_VERSION = 1;
const SQLITE_FILE_RETRY_DELAY_MS = 50;
const SQLITE_FILE_RETRY_COUNT = 40;

async function retryUnlink(targetPath, retries = SQLITE_FILE_RETRY_COUNT) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await fs.unlink(targetPath);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EBUSY') {
        throw error;
      }
      if (attempt === retries) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
        return;
      }
      if (error?.code === 'EBUSY') {
        await new Promise((resolve) => setTimeout(resolve, SQLITE_FILE_RETRY_DELAY_MS));
      }
    }
  }
}

async function bestEffortUnlink(targetPath) {
  try {
    await retryUnlink(targetPath);
  } catch {
    // ignore cleanup failures (e.g. antivirus locks on Windows)
  }
}

async function retryRename(fromPath, toPath, retries = SQLITE_FILE_RETRY_COUNT) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await fs.rename(fromPath, toPath);
      return;
    } catch (error) {
      if (error?.code !== 'EBUSY') {
        throw error;
      }
      if (attempt === retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, SQLITE_FILE_RETRY_DELAY_MS));
    }
  }
}

/**
 * SQLite-backed vector store for embeddings cache.
 * Follows the same API pattern as BinaryVectorStore for compatibility.
 */
export class SqliteVectorStore {
  constructor({ db, dim, count }) {
    this.db = db;
    this.dim = dim;
    this.count = count;

    // Prepared statements for fast access
    this._stmtGetChunk = db.prepare(`
      SELECT file, startLine, endLine, content, vector FROM chunks WHERE id = ?
    `);
    this._stmtGetVector = db.prepare(`SELECT vector FROM chunks WHERE id = ?`);
    this._stmtGetContent = db.prepare(`SELECT content FROM chunks WHERE id = ?`);
    this._stmtGetAllFiles = db.prepare(`SELECT DISTINCT file FROM chunks`);
    this._stmtGetChunksForFile = db.prepare(`SELECT id FROM chunks WHERE file = ?`);
  }

  /**
   * Close the database connection
   */
  close() {
    if (this.db && this.db.open) {
      this.db.close();
    }
  }

  /**
   * Get the path to the SQLite file
   */
  static getPath(cacheDir) {
    return path.join(cacheDir, SQLITE_FILE);
  }

  /**
   * Load an existing SQLite vector store from disk
   */
  static async load(cacheDir, options = {}) {
    const dbPath = SqliteVectorStore.getPath(cacheDir);

    try {
      await fs.access(dbPath);
    } catch {
      return null; // File doesn't exist
    }

    const db = new Database(dbPath, { readonly: true });

    // Read metadata
    const meta = db.prepare(`SELECT key, value FROM metadata`).all();
    const metaMap = new Map(meta.map((r) => [r.key, r.value]));

    const version = parseInt(metaMap.get('version') || '0', 10);
    if (version !== STORE_VERSION) {
      db.close();
      return null; // Version mismatch, need reindex
    }

    const dim = parseInt(metaMap.get('dim') || '0', 10);
    const count = parseInt(metaMap.get('count') || '0', 10);

    return new SqliteVectorStore({ db, dim, count });
  }

  /**
   * Get the number of chunks in the store
   */
  length() {
    return this.count;
  }

  /**
   * Get a chunk record by index (0-based)
   */
  getRecord(index) {
    if (index < 0 || index >= this.count) return null;

    const row = this._stmtGetChunk.get(index);
    if (!row) return null;

    return {
      file: row.file,
      startLine: row.startLine,
      endLine: row.endLine,
    };
  }

  /**
   * Get a vector by index (0-based)
   * Returns Float32Array
   */
  getVector(index) {
    if (index < 0 || index >= this.count) return null;

    const row = this._stmtGetVector.get(index);
    if (!row || !row.vector) return null;

    // Vector is stored as a Buffer of Float32 values
    const expectedBytes = this.dim * Float32Array.BYTES_PER_ELEMENT;
    if (row.vector.byteLength < expectedBytes) return null;
    return new Float32Array(row.vector.buffer, row.vector.byteOffset, this.dim);
  }

  /**
   * Get content by index (0-based)
   */
  getContent(index) {
    if (index < 0 || index >= this.count) return null;

    const row = this._stmtGetContent.get(index);
    return row ? row.content : null;
  }

  /**
   * Get all chunks as lightweight views (for search iteration)
   */
  toChunkViews({ includeContent = false, includeVector = true } = {}) {
    const views = [];
    const stmt = this.db.prepare(`
      SELECT id, file, startLine, endLine${includeContent ? ', content' : ''}${includeVector ? ', vector' : ''}
      FROM chunks ORDER BY id
    `);

    for (const row of stmt.iterate()) {
      const view = {
        index: row.id,
        file: row.file,
        startLine: row.startLine,
        endLine: row.endLine,
        _sqliteIndex: row.id,
      };

      if (includeContent) {
        view.content = row.content;
      }

      if (includeVector && row.vector) {
        view.vector = new Float32Array(
          row.vector.buffer,
          row.vector.byteOffset,
          this.dim
        );
      }

      views.push(view);
    }

    return views;
  }

  /**
   * Get all unique file paths and their chunk indices
   */
  getAllFileIndices() {
    const fileIndices = new Map();

    const files = this._stmtGetAllFiles.all();
    for (const { file } of files) {
      const chunks = this._stmtGetChunksForFile.all(file);
      fileIndices.set(file, chunks.map((c) => c.id));
    }

    return fileIndices;
  }

  /**
   * Write chunks to a new SQLite database
   * @param {string} cacheDir - Directory to write the database
   * @param {Array} chunks - Array of chunk objects with vector, file, startLine, endLine, content
   * @param {Object} options - { getContent, preRename }
   */
  static async write(cacheDir, chunks, { getContent, preRename } = {}) {
    if (!chunks || chunks.length === 0) {
      return null;
    }

    await fs.mkdir(cacheDir, { recursive: true });

    const dbPath = SqliteVectorStore.getPath(cacheDir);
    const useTemp = process.platform !== 'win32';
    const tempSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tempPath = `${dbPath}.tmp-${tempSuffix}`;
    const writePath = useTemp ? tempPath : dbPath;

    const denseChunks = [];
    const denseSourceIndices = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (!chunk) continue;
      denseChunks.push(chunk);
      denseSourceIndices.push(i);
    }

    const resolveContent = async (chunk, sourceIndex) => {
      if (chunk.content !== undefined && chunk.content !== null) {
        return chunk.content;
      }
      if (typeof getContent === 'function') {
        const value = getContent(chunk, sourceIndex);
        if (value && typeof value.then === 'function') {
          return await value;
        }
        return value;
      }
      return null;
    };

    let dim = null;
    const resolvedData = new Array(denseChunks.length);
    for (let i = 0; i < denseChunks.length; i += 1) {
      const chunk = denseChunks[i];
      const sourceIndex = denseSourceIndices[i];

      if (chunk.vector === undefined || chunk.vector === null) {
        throw new Error(`Missing vector data for sqlite cache write at index ${sourceIndex}`);
      }

      const vector =
        chunk.vector instanceof Float32Array ? chunk.vector : Float32Array.from(chunk.vector);
      if (!vector || vector.length === 0) {
        throw new Error(`Empty vector data for sqlite cache write at index ${sourceIndex}`);
      }
      if (dim === null) {
        dim = vector.length;
      } else if (vector.length !== dim) {
        throw new Error('Vector dimension mismatch in sqlite cache write');
      }

      let content = await resolveContent(chunk, sourceIndex);
      if (content === undefined) content = null;
      if (content !== null && typeof content !== 'string') {
        content = String(content);
      }

      resolvedData[i] = {
        file: chunk.file,
        startLine: chunk.startLine ?? 0,
        endLine: chunk.endLine ?? 0,
        content,
        vectorBlob: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
      };
    }

    if (!dim) dim = 0;

    // Create new database
    const db = new Database(writePath);

    // Enable WAL mode for better concurrent read performance (use DELETE on Windows to reduce locks)
    db.pragma(`journal_mode = ${useTemp ? 'WAL' : 'DELETE'}`);
    db.pragma('synchronous = NORMAL');

    // Create tables
    if (!useTemp) {
      db.exec(`
        DROP TABLE IF EXISTS metadata;
        DROP TABLE IF EXISTS chunks;
      `);
    }

    db.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY,
        file TEXT NOT NULL,
        startLine INTEGER NOT NULL,
        endLine INTEGER NOT NULL,
        content TEXT,
        vector BLOB
      );

      CREATE INDEX idx_chunks_file ON chunks(file);
    `);

    // Insert metadata
    const insertMeta = db.prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)`);
    insertMeta.run('version', String(STORE_VERSION));
    insertMeta.run('dim', String(dim));
    insertMeta.run('count', String(resolvedData.length));
    insertMeta.run('createdAt', new Date().toISOString());

    // Insert chunks in a transaction for speed
    const insertChunk = db.prepare(`
      INSERT INTO chunks (id, file, startLine, endLine, content, vector)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((items) => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        insertChunk.run(
          i,
          item.file,
          item.startLine,
          item.endLine,
          item.content,
          item.vectorBlob
        );
      }
    });

    insertMany(resolvedData);

    // Optimize the database
    db.exec('ANALYZE');
    db.close();
    if (process.platform === 'win32') {
      // Windows needs more time to release file locks after WAL mode close
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Call preRename hook if provided (for atomicity coordination)
    if (typeof preRename === 'function') {
      await preRename();
    }

    // Atomic rename (temp path only)
    if (useTemp) {
      await retryUnlink(dbPath);
      await retryRename(tempPath, dbPath);
    }

    // Clean up WAL files from temp
    if (useTemp) {
      await bestEffortUnlink(tempPath + '-wal');
      await bestEffortUnlink(tempPath + '-shm');
    } else {
      await bestEffortUnlink(dbPath + '-wal');
      await bestEffortUnlink(dbPath + '-shm');
    }

    // Return a new instance opened readonly
    return SqliteVectorStore.load(cacheDir);
  }
}

export default SqliteVectorStore;
