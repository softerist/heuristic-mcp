

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs/promises';
import {
  SQLITE_FILE_RETRY_DELAY_MS,
  SQLITE_FILE_RETRY_COUNT,
  SQLITE_STORE_VERSION as STORE_VERSION,
} from './constants.js';

const SQLITE_FILE = 'vectors.sqlite';

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


export class SqliteVectorStore {
  constructor({ db, dim, count }) {
    this.db = db;
    this.dim = dim;
    this.count = count;

    
    this._stmtGetChunk = db.prepare(`
      SELECT file, startLine, endLine, content, vector FROM chunks WHERE id = ?
    `);
    this._stmtGetVector = db.prepare(`SELECT vector FROM chunks WHERE id = ?`);
    this._stmtGetContent = db.prepare(`SELECT content FROM chunks WHERE id = ?`);
    this._stmtGetAllFiles = db.prepare(`SELECT DISTINCT file FROM chunks`);
    this._stmtGetChunksForFile = db.prepare(`SELECT id FROM chunks WHERE file = ?`);
  }

  
  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      if (this.db && this.db.open) {
        this.db.close();
      }
    } catch {
      
    }
  }

  
  static getPath(cacheDir) {
    return path.join(cacheDir, SQLITE_FILE);
  }

  
  static async load(cacheDir, _options = {}) {
    const dbPath = SqliteVectorStore.getPath(cacheDir);

    try {
      await fs.access(dbPath);
    } catch {
      return null; 
    }

    let db;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch (err) {
      
      console.warn(`[SQLite] Failed to open database: ${err.message}`);
      return null;
    }

    
    let meta;
    try {
      meta = db.prepare(`SELECT key, value FROM metadata`).all();
    } catch (err) {
      
      console.warn(`[SQLite] Failed to read metadata: ${err.message}`);
      db.close();
      return null;
    }
    const metaMap = new Map(meta.map((r) => [r.key, r.value]));

    const version = parseInt(metaMap.get('version') || '0', 10);
    if (version !== STORE_VERSION) {
      db.close();
      return null; 
    }

    const dim = parseInt(metaMap.get('dim') || '0', 10);
    const count = parseInt(metaMap.get('count') || '0', 10);

    return new SqliteVectorStore({ db, dim, count });
  }

  
  length() {
    return this.count;
  }

  
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

  
  getVector(index) {
    if (index < 0 || index >= this.count) return null;

    const row = this._stmtGetVector.get(index);
    if (!row || !row.vector) return null;

    
    const expectedBytes = this.dim * Float32Array.BYTES_PER_ELEMENT;
    if (row.vector.byteLength < expectedBytes) return null;
    
    const view = new Float32Array(row.vector.buffer, row.vector.byteOffset, this.dim);
    return new Float32Array(view);
  }

  
  getContent(index) {
    if (index < 0 || index >= this.count) return null;

    const row = this._stmtGetContent.get(index);
    return row ? row.content : null;
  }

  
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
        const expectedBytes = this.dim * Float32Array.BYTES_PER_ELEMENT;
        if (row.vector.byteLength >= expectedBytes) {
          
          const bufferView = new Float32Array(
            row.vector.buffer,
            row.vector.byteOffset,
            this.dim
          );
          view.vector = new Float32Array(bufferView);
        }
      }

      views.push(view);
    }

    return views;
  }

  
  getAllFileIndices() {
    const fileIndices = new Map();

    const files = this._stmtGetAllFiles.all();
    for (const { file } of files) {
      const chunks = this._stmtGetChunksForFile.all(file);
      fileIndices.set(file, chunks.map((c) => c.id));
    }

    return fileIndices;
  }

  
  static async write(cacheDir, chunks, { getContent, getVector, preRename } = {}) {
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

    const resolveVector = async (chunk, sourceIndex) => {
      let vectorSource = chunk.vector;
      if (
        (vectorSource === undefined || vectorSource === null) &&
        typeof getVector === 'function'
      ) {
        vectorSource = getVector(chunk, sourceIndex);
        if (vectorSource && typeof vectorSource.then === 'function') {
          vectorSource = await vectorSource;
        }
      }
      if (vectorSource === undefined || vectorSource === null) {
        throw new Error(`Missing vector data for sqlite cache write at index ${sourceIndex}`);
      }
      const vector =
        vectorSource instanceof Float32Array
          ? vectorSource
          : ArrayBuffer.isView(vectorSource)
            ? Float32Array.from(vectorSource)
            : Float32Array.from(vectorSource);
      if (!vector || vector.length === 0) {
        throw new Error(`Empty vector data for sqlite cache write at index ${sourceIndex}`);
      }
      return vector;
    };

    const dim =
      denseChunks.length > 0
        ? (await resolveVector(denseChunks[0], denseSourceIndices[0])).length
        : 0;

    
    const db = new Database(writePath);

    
    db.pragma(`journal_mode = ${useTemp ? 'WAL' : 'DELETE'}`);
    db.pragma('synchronous = NORMAL');

    
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

    
    const insertMeta = db.prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)`);
    insertMeta.run('version', String(STORE_VERSION));
    insertMeta.run('dim', String(dim));
    insertMeta.run('count', String(denseChunks.length));
    insertMeta.run('createdAt', new Date().toISOString());

    
    const insertChunk = db.prepare(`
      INSERT INTO chunks (id, file, startLine, endLine, content, vector)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    db.exec('BEGIN');
    try {
      for (let i = 0; i < denseChunks.length; i += 1) {
        const chunk = denseChunks[i];
        const sourceIndex = denseSourceIndices[i];
        const vector = await resolveVector(chunk, sourceIndex);
        if (vector.length !== dim) {
          throw new Error('Vector dimension mismatch in sqlite cache write');
        }
        let content = await resolveContent(chunk, sourceIndex);
        if (content === undefined) content = null;
        if (content !== null && typeof content !== 'string') {
          content = String(content);
        }
        insertChunk.run(
          i,
          chunk.file,
          chunk.startLine ?? 0,
          chunk.endLine ?? 0,
          content,
          Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        
      }
      throw error;
    }

    
    db.exec('ANALYZE');
    db.close();
    if (process.platform === 'win32') {
      
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    
    if (typeof preRename === 'function') {
      await preRename();
    }

    
    if (useTemp) {
      await retryUnlink(dbPath);
      await retryRename(tempPath, dbPath);
    }

    
    if (useTemp) {
      await bestEffortUnlink(tempPath + '-wal');
      await bestEffortUnlink(tempPath + '-shm');
    } else {
      await bestEffortUnlink(dbPath + '-wal');
      await bestEffortUnlink(dbPath + '-shm');
    }

    
    return SqliteVectorStore.load(cacheDir);
  }
}

export default SqliteVectorStore;
