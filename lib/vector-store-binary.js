import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import {
  BINARY_STORE_VERSION as STORE_VERSION,
  BINARY_VECTOR_HEADER_SIZE as VECTOR_HEADER_SIZE,
  BINARY_RECORD_HEADER_SIZE as RECORD_HEADER_SIZE,
  BINARY_CONTENT_HEADER_SIZE as CONTENT_HEADER_SIZE,
  BINARY_RECORD_SIZE as RECORD_SIZE,
} from './constants.js';

const MAGIC_VECTORS = 'HMCV';
const MAGIC_RECORDS = 'HMCR';
const MAGIC_CONTENT = 'HMCC';

const VECTORS_FILE = 'vectors.bin';
const RECORDS_FILE = 'records.bin';
const CONTENT_FILE = 'content.bin';
const FILES_FILE = 'files.json';
const RETRYABLE_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function renameWithRetry(source, target, { retries = 5, delayMs = 50 } = {}) {
  let attempt = 0;
  let delay = delayMs;
  while (true) {
    try {
      await fs.rename(source, target);
      return;
    } catch (err) {
      const code = err?.code;
      if (!RETRYABLE_RENAME_ERRORS.has(code) || attempt >= retries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt += 1;
      delay *= 2;
    }
  }
}

function writeMagic(buffer, magic) {
  buffer.write(magic, 0, 'ascii');
}

function readMagic(buffer) {
  return buffer.toString('ascii', 0, 4);
}

function ensureLittleEndian() {
  if (os.endianness() !== 'LE') {
    throw new Error('Binary vector store requires little-endian architecture');
  }
}

function getDataView(buffer) {
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function readHeader(buffer, magic, headerSize) {
  if (buffer.length < headerSize) {
    throw new Error('Binary store header is truncated');
  }
  const actualMagic = readMagic(buffer);
  if (actualMagic !== magic) {
    throw new Error(`Invalid binary store magic (${actualMagic})`);
  }
  const view = getDataView(buffer);
  const version = view.getUint32(4, true);
  if (version !== STORE_VERSION) {
    throw new Error(`Unsupported binary store version (${version})`);
  }
  return view;
}

function writeVectorsHeader(buffer, dim, count) {
  writeMagic(buffer, MAGIC_VECTORS);
  const view = getDataView(buffer);
  view.setUint32(4, STORE_VERSION, true);
  view.setUint32(8, dim, true);
  view.setUint32(12, count, true);
  view.setUint32(16, 0, true);
}

function writeRecordsHeader(buffer, count, fileCount) {
  writeMagic(buffer, MAGIC_RECORDS);
  const view = getDataView(buffer);
  view.setUint32(4, STORE_VERSION, true);
  view.setUint32(8, count, true);
  view.setUint32(12, fileCount, true);
  view.setUint32(16, 0, true);
}

function writeContentHeader(buffer, totalBytes) {
  writeMagic(buffer, MAGIC_CONTENT);
  const view = getDataView(buffer);
  view.setUint32(4, STORE_VERSION, true);
  const value = BigInt(totalBytes);
  view.setBigUint64(8, value, true);
  view.setUint32(16, 0, true);
}

function readBigUint(view, offset) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Binary store content offset exceeds safe integer range');
  }
  return Number(value);
}

function normalizeContent(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return String(value);
  return value;
}

export class BinaryVectorStore {
  constructor({
    vectorsBuffer,
    recordsBuffer,
    vectorsHandle,
    vectorsFd,
    contentHandle,
    contentBuffer,
    contentSize,
    files,
    dim,
    count,
    contentCacheEntries,
    vectorCacheEntries,
  }) {
    this.vectorsBuffer = vectorsBuffer;
    this.recordsBuffer = recordsBuffer;
    this.vectorsHandle = vectorsHandle ?? null;
    this.vectorsFd = Number.isInteger(vectorsFd) ? vectorsFd : null;
    this.contentHandle = contentHandle ?? null;
    this.contentBuffer = contentBuffer ?? null;
    this.contentSize = Number.isFinite(contentSize)
      ? contentSize
      : contentBuffer
        ? Math.max(0, contentBuffer.length - CONTENT_HEADER_SIZE)
        : 0;
    this.files = files;
    this.dim = dim;
    this.count = count;
    this.contentCacheEntries = Number.isInteger(contentCacheEntries) ? contentCacheEntries : 256;
    this.contentCache = new Map();
    this.vectorCacheEntries = Number.isInteger(vectorCacheEntries) ? vectorCacheEntries : 0;
    this.vectorCache = new Map();

    this.vectorDataOffset = VECTOR_HEADER_SIZE;
    this.recordDataOffset = RECORD_HEADER_SIZE;
    this.contentDataOffset = CONTENT_HEADER_SIZE;
  }

  async close() {
    this.contentCache.clear();
    this.vectorCache.clear();
    this.vectorsBuffer = null;
    this.recordsBuffer = null;
    this.contentBuffer = null;
    this.files = null;
    if (this.vectorsHandle) {
      try {
        await this.vectorsHandle.close();
      } catch {
        
      }
    }
    this.vectorsHandle = null;
    if (Number.isInteger(this.vectorsFd)) {
      try {
        fsSync.closeSync(this.vectorsFd);
      } catch {
        
      }
    }
    this.vectorsFd = null;
    if (this.contentHandle) {
      try {
        await this.contentHandle.close();
      } catch {
        
      }
    }
    this.contentHandle = null;
  }

  static getPaths(cacheDir) {
    return {
      vectorsPath: path.join(cacheDir, VECTORS_FILE),
      recordsPath: path.join(cacheDir, RECORDS_FILE),
      contentPath: path.join(cacheDir, CONTENT_FILE),
      filesPath: path.join(cacheDir, FILES_FILE),
    };
  }

  static async load(cacheDir, { contentCacheEntries, vectorCacheEntries, vectorLoadMode } = {}) {
    ensureLittleEndian();
    const { vectorsPath, recordsPath, contentPath, filesPath } =
      BinaryVectorStore.getPaths(cacheDir);

    let contentReadHandle = null;
    let vectorsFd = null;

    try {
      const loadVectorsFromDisk = String(vectorLoadMode).toLowerCase() === 'disk';
      let vectorsBuffer = null;

      const [recordsBuffer, filesRaw] = await Promise.all([
        fs.readFile(recordsPath),
        fs.readFile(filesPath, 'utf-8'),
      ]);

      if (loadVectorsFromDisk) {
        vectorsFd = fsSync.openSync(vectorsPath, 'r');
        const headerBuffer = Buffer.alloc(VECTOR_HEADER_SIZE);
        const bytesRead = fsSync.readSync(vectorsFd, headerBuffer, 0, VECTOR_HEADER_SIZE, 0);
        if (bytesRead < VECTOR_HEADER_SIZE) {
          throw new Error('Binary store vectors header is truncated');
        }
        vectorsBuffer = headerBuffer;
      } else {
        vectorsBuffer = await fs.readFile(vectorsPath);
      }

      const vectorsView = readHeader(vectorsBuffer, MAGIC_VECTORS, VECTOR_HEADER_SIZE);
      const dim = vectorsView.getUint32(8, true);
      const count = vectorsView.getUint32(12, true);

      const recordsView = readHeader(recordsBuffer, MAGIC_RECORDS, RECORD_HEADER_SIZE);
      const recordCount = recordsView.getUint32(8, true);
      const fileCount = recordsView.getUint32(12, true);

      if (recordCount !== count) {
        throw new Error(`Binary store count mismatch (${recordCount} != ${count})`);
      }

      contentReadHandle = await fs.open(contentPath, 'r');
      let totalContentBytes = 0;

      const headerBuffer = Buffer.alloc(CONTENT_HEADER_SIZE);
      const { bytesRead } = await contentReadHandle.read(headerBuffer, 0, CONTENT_HEADER_SIZE, 0);
      if (bytesRead < CONTENT_HEADER_SIZE) {
        throw new Error('Binary store content header is truncated');
      }
      const contentView = readHeader(headerBuffer, MAGIC_CONTENT, CONTENT_HEADER_SIZE);
      totalContentBytes = readBigUint(contentView, 8);
      const stats = await contentReadHandle.stat();
      const expectedContentSize = CONTENT_HEADER_SIZE + totalContentBytes;
      if (stats.size < expectedContentSize) {
        throw new Error('Binary store content file truncated');
      }

      const files = JSON.parse(filesRaw);
      if (!Array.isArray(files) || files.length !== fileCount) {
        throw new Error('Binary store file table is invalid');
      }

      return new BinaryVectorStore({
        vectorsBuffer,
        recordsBuffer,
        vectorsHandle: null,
        vectorsFd,
        contentHandle: contentReadHandle,
        contentSize: totalContentBytes,
        files,
        dim,
        count,
        contentCacheEntries,
        vectorCacheEntries,
      });
    } catch (err) {
      if (contentReadHandle) await contentReadHandle.close().catch(() => {});
      if (Number.isInteger(vectorsFd)) {
        try {
          fsSync.closeSync(vectorsFd);
        } catch {
          
        }
      }
      throw err;
    }
  }

  get length() {
    return this.count;
  }

  getRecord(index) {
    if (index < 0 || index >= this.count) return null;
    const offset = this.recordDataOffset + index * RECORD_SIZE;
    const view = getDataView(this.recordsBuffer);

    const fileId = view.getUint32(offset, true);
    const startLine = view.getUint32(offset + 4, true);
    const endLine = view.getUint32(offset + 8, true);
    const contentOffset = readBigUint(view, offset + 12);
    const contentLength = view.getUint32(offset + 20, true);

    return {
      fileId,
      file: this.files[fileId],
      startLine,
      endLine,
      contentOffset,
      contentLength,
    };
  }

  getVector(index) {
    if (index < 0 || index >= this.count) return null;
    if (this.vectorCacheEntries > 0) {
      const cached = this.vectorCache.get(index);
      if (cached) {
        this.vectorCache.delete(index);
        this.vectorCache.set(index, cached);
        return cached;
      }
    }

    const offset = this.vectorDataOffset + index * this.dim * 4;
    const byteLength = this.dim * 4;
    let vector = null;

    if (this.vectorsBuffer && this.vectorsBuffer.length >= this.vectorDataOffset + byteLength) {
      vector = new Float32Array(
        this.vectorsBuffer.buffer,
        this.vectorsBuffer.byteOffset + offset,
        this.dim
      );
    } else if (Number.isInteger(this.vectorsFd)) {
      
      
      const buffer = Buffer.alloc(byteLength);
      const bytesRead = fsSync.readSync(this.vectorsFd, buffer, 0, byteLength, offset);
      if (bytesRead === byteLength) {
        vector = new Float32Array(buffer.buffer, buffer.byteOffset, this.dim);
      }
    }

    if (vector && this.vectorCacheEntries > 0) {
      this.vectorCache.set(index, vector);
      if (this.vectorCache.size > this.vectorCacheEntries) {
        const firstKey = this.vectorCache.keys().next().value;
        this.vectorCache.delete(firstKey);
      }
    }

    return vector;
  }

  async getContent(index) {
    if (index < 0 || index >= this.count) return null;
    if (this.contentCacheEntries > 0) {
      const cached = this.contentCache.get(index);
      if (cached !== undefined) {
        this.contentCache.delete(index);
        this.contentCache.set(index, cached);
        return cached;
      }
    }

    const record = this.getRecord(index);
    if (!record || record.contentLength === 0) return '';
    const contentLimit = record.contentOffset + record.contentLength;
    if (Number.isFinite(this.contentSize) && contentLimit > this.contentSize) {
      return '';
    }

    let content = '';
    if (this.contentBuffer) {
      const start = this.contentDataOffset + record.contentOffset;
      const end = start + record.contentLength;
      content = this.contentBuffer.slice(start, end).toString('utf-8');
    } else if (this.contentHandle) {
      const start = this.contentDataOffset + record.contentOffset;
      const length = record.contentLength;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await this.contentHandle.read(buffer, 0, length, start);
      content = buffer.slice(0, bytesRead).toString('utf-8');
    } else {
      return '';
    }

    if (this.contentCacheEntries > 0) {
      this.contentCache.set(index, content);
      if (this.contentCache.size > this.contentCacheEntries) {
        const firstKey = this.contentCache.keys().next().value;
        this.contentCache.delete(firstKey);
      }
    }

    return content;
  }

  async toChunkViews({ includeContent = false, includeVector = true } = {}) {
    const chunks = new Array(this.count);
    for (let i = 0; i < this.count; i += 1) {
      const record = this.getRecord(i);
      if (!record) continue;
      const chunk = {
        file: record.file,
        startLine: record.startLine,
        endLine: record.endLine,
        _index: i,
        _binaryIndex: i,
      };
      if (includeVector) {
        chunk.vector = this.getVector(i);
      }
      if (includeContent) {
        chunk.content = await this.getContent(i);
      }
      chunks[i] = chunk;
    }
    return chunks;
  }

  getAllFileIndices() {
    const map = new Map();
    for (let i = 0; i < this.count; i++) {
      const record = this.getRecord(i);
      if (record) {
        let list = map.get(record.file);
        if (!list) {
          list = [];
          map.set(record.file, list);
        }
        list.push(i);
      }
    }
    return map;
  }

  static async write(
    cacheDir,
    chunks,
    {
      contentCacheEntries,
      vectorCacheEntries,
      vectorLoadMode,
      getContent,
      getVector,
      preRename,
    } = {}
  ) {
    ensureLittleEndian();
    const { vectorsPath, recordsPath, contentPath, filesPath } =
      BinaryVectorStore.getPaths(cacheDir);

    const tmpSuffix = `.tmp-${process.pid}`;
    const vectorsTmp = `${vectorsPath}${tmpSuffix}`;
    const recordsTmp = `${recordsPath}${tmpSuffix}`;
    const contentTmp = `${contentPath}${tmpSuffix}`;
    const filesTmp = `${filesPath}${tmpSuffix}`;

    const fileIds = new Map();
    const files = [];
    const denseChunks = [];
    const denseSourceIndices = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (!chunk) continue;
      denseChunks.push(chunk);
      denseSourceIndices.push(i);
    }

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
        throw new Error(`Missing vector data for binary cache write at index ${sourceIndex}`);
      }
      const vector =
        vectorSource instanceof Float32Array
          ? vectorSource
          : ArrayBuffer.isView(vectorSource)
            ? Float32Array.from(vectorSource)
            : new Float32Array(vectorSource);
      if (!vector || vector.length === 0) {
        throw new Error(`Empty vector data for binary cache write at index ${sourceIndex}`);
      }
      return vector;
    };

    const resolveContent = async (chunk, sourceIndex) => {
      const contentSource =
        chunk.content !== undefined && chunk.content !== null
          ? chunk.content
          : getContent
            ? await getContent(chunk, sourceIndex)
            : '';
      return normalizeContent(contentSource);
    };

    const recordEntries = new Array(denseChunks.length);
    let contentOffset = 0;

    for (let i = 0; i < denseChunks.length; i += 1) {
      const chunk = denseChunks[i];
      const sourceIndex = denseSourceIndices[i];

      const file = chunk.file;
      if (!fileIds.has(file)) {
        fileIds.set(file, files.length);
        files.push(file);
      }

      const contentValue = await resolveContent(chunk, sourceIndex);
      const contentLength = Buffer.byteLength(contentValue, 'utf-8');

      recordEntries[i] = {
        fileId: fileIds.get(file),
        startLine: chunk.startLine ?? 0,
        endLine: chunk.endLine ?? 0,
        contentOffset,
        contentLength,
      };

      contentOffset += contentLength;
    }

    const count = denseChunks.length;
    const dim =
      count > 0 ? (await resolveVector(denseChunks[0], denseSourceIndices[0])).length : 0;

    await fs.writeFile(filesTmp, JSON.stringify(files));

    let vectorsHandle = null;
    let recordsHandle = null;
    let contentHandle = null;

    try {
      vectorsHandle = await fs.open(vectorsTmp, 'w');
      recordsHandle = await fs.open(recordsTmp, 'w');
      contentHandle = await fs.open(contentTmp, 'w');

      const vectorsHeader = Buffer.alloc(VECTOR_HEADER_SIZE);
      writeVectorsHeader(vectorsHeader, dim, count);
      await vectorsHandle.write(vectorsHeader, 0, vectorsHeader.length, 0);

      const recordsHeader = Buffer.alloc(RECORD_HEADER_SIZE);
      writeRecordsHeader(recordsHeader, count, files.length);
      await recordsHandle.write(recordsHeader, 0, recordsHeader.length, 0);

      const contentHeader = Buffer.alloc(CONTENT_HEADER_SIZE);
      writeContentHeader(contentHeader, contentOffset);
      await contentHandle.write(contentHeader, 0, contentHeader.length, 0);

      let vectorPos = VECTOR_HEADER_SIZE;
      let recordPos = RECORD_HEADER_SIZE;
      let contentPos = CONTENT_HEADER_SIZE;

      for (let i = 0; i < count; i += 1) {
        const entry = recordEntries[i];
        if (!entry) continue;

        const recordBuffer = Buffer.alloc(RECORD_SIZE);
        const view = getDataView(recordBuffer);
        view.setUint32(0, entry.fileId, true);
        view.setUint32(4, entry.startLine, true);
        view.setUint32(8, entry.endLine, true);
        view.setBigUint64(12, BigInt(entry.contentOffset), true);
        view.setUint32(20, entry.contentLength, true);
        view.setUint32(24, 0, true);
        view.setUint32(28, 0, true);

        await recordsHandle.write(recordBuffer, 0, recordBuffer.length, recordPos);
        recordPos += recordBuffer.length;

        const chunk = denseChunks[i];
        const sourceIndex = denseSourceIndices[i];
        const vector = await resolveVector(chunk, sourceIndex);
        if (vector.length !== dim) {
          throw new Error('Vector dimension mismatch in binary cache write');
        }
        const vectorBuffer = Buffer.from(
          vector.buffer,
          vector.byteOffset,
          vector.byteLength
        );
        await vectorsHandle.write(vectorBuffer, 0, vectorBuffer.length, vectorPos);
        vectorPos += vectorBuffer.length;

        if (entry.contentLength > 0) {
          
          const val = await resolveContent(chunk, sourceIndex);
          const contentBuffer = Buffer.from(val, 'utf-8');
          await contentHandle.write(contentBuffer, 0, contentBuffer.length, contentPos);
          contentPos += contentBuffer.length;
        }
      }
    } finally {
      const closes = [];
      if (vectorsHandle) closes.push(vectorsHandle.close().catch(() => {}));
      if (recordsHandle) closes.push(recordsHandle.close().catch(() => {}));
      if (contentHandle) closes.push(contentHandle.close().catch(() => {}));
      await Promise.all(closes);
    }

    if (preRename) {
      await preRename();
    }

    await Promise.all([
      renameWithRetry(vectorsTmp, vectorsPath),
      renameWithRetry(recordsTmp, recordsPath),
      renameWithRetry(contentTmp, contentPath),
      renameWithRetry(filesTmp, filesPath),
    ]);

    return BinaryVectorStore.load(cacheDir, {
      contentCacheEntries,
      vectorCacheEntries,
      vectorLoadMode,
    });
  }
}
