import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const MAGIC_VECTORS = 'HMCV';
const MAGIC_RECORDS = 'HMCR';
const MAGIC_CONTENT = 'HMCC';
const STORE_VERSION = 1;

const VECTOR_HEADER_SIZE = 20;
const RECORD_HEADER_SIZE = 20;
const CONTENT_HEADER_SIZE = 20;
const RECORD_SIZE = 32;

const VECTORS_FILE = 'vectors.bin';
const RECORDS_FILE = 'records.bin';
const CONTENT_FILE = 'content.bin';
const FILES_FILE = 'files.json';

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
  constructor({ vectorsBuffer, recordsBuffer, contentBuffer, files, dim, count, contentCacheEntries }) {
    this.vectorsBuffer = vectorsBuffer;
    this.recordsBuffer = recordsBuffer;
    this.contentBuffer = contentBuffer;
    this.files = files;
    this.dim = dim;
    this.count = count;
    this.contentCacheEntries = Number.isInteger(contentCacheEntries) ? contentCacheEntries : 256;
    this.contentCache = new Map();

    this.vectorDataOffset = VECTOR_HEADER_SIZE;
    this.recordDataOffset = RECORD_HEADER_SIZE;
    this.contentDataOffset = CONTENT_HEADER_SIZE;
  }

  static getPaths(cacheDir) {
    return {
      vectorsPath: path.join(cacheDir, VECTORS_FILE),
      recordsPath: path.join(cacheDir, RECORDS_FILE),
      contentPath: path.join(cacheDir, CONTENT_FILE),
      filesPath: path.join(cacheDir, FILES_FILE),
    };
  }

  static async load(cacheDir, { contentCacheEntries } = {}) {
    ensureLittleEndian();
    const { vectorsPath, recordsPath, contentPath, filesPath } = BinaryVectorStore.getPaths(cacheDir);

    const [vectorsBuffer, recordsBuffer, contentBuffer, filesRaw] = await Promise.all([
      fs.readFile(vectorsPath),
      fs.readFile(recordsPath),
      fs.readFile(contentPath),
      fs.readFile(filesPath, 'utf-8'),
    ]);

    const vectorsView = readHeader(vectorsBuffer, MAGIC_VECTORS, VECTOR_HEADER_SIZE);
    const dim = vectorsView.getUint32(8, true);
    const count = vectorsView.getUint32(12, true);

    const recordsView = readHeader(recordsBuffer, MAGIC_RECORDS, RECORD_HEADER_SIZE);
    const recordCount = recordsView.getUint32(8, true);
    const fileCount = recordsView.getUint32(12, true);

    if (recordCount !== count) {
      throw new Error(`Binary store count mismatch (${recordCount} != ${count})`);
    }

    const contentView = readHeader(contentBuffer, MAGIC_CONTENT, CONTENT_HEADER_SIZE);
    const totalContentBytes = readBigUint(contentView, 8);
    const expectedContentSize = CONTENT_HEADER_SIZE + totalContentBytes;
    if (contentBuffer.length < expectedContentSize) {
      throw new Error('Binary store content file truncated');
    }

    const files = JSON.parse(filesRaw);
    if (!Array.isArray(files) || files.length !== fileCount) {
      throw new Error('Binary store file table is invalid');
    }

    return new BinaryVectorStore({
      vectorsBuffer,
      recordsBuffer,
      contentBuffer,
      files,
      dim,
      count,
      contentCacheEntries,
    });
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
    const offset = this.vectorDataOffset + index * this.dim * 4;
    return new Float32Array(
      this.vectorsBuffer.buffer,
      this.vectorsBuffer.byteOffset + offset,
      this.dim,
    );
  }

  getContent(index) {
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

    const start = this.contentDataOffset + record.contentOffset;
    const end = start + record.contentLength;
    const content = this.contentBuffer.slice(start, end).toString('utf-8');

    if (this.contentCacheEntries > 0) {
      this.contentCache.set(index, content);
      if (this.contentCache.size > this.contentCacheEntries) {
        const firstKey = this.contentCache.keys().next().value;
        this.contentCache.delete(firstKey);
      }
    }

    return content;
  }

  toChunkViews({ includeContent = false } = {}) {
    const chunks = new Array(this.count);
    for (let i = 0; i < this.count; i += 1) {
      const record = this.getRecord(i);
      if (!record) continue;
      const chunk = {
        file: record.file,
        startLine: record.startLine,
        endLine: record.endLine,
        vector: this.getVector(i),
        _index: i,
      };
      if (includeContent) {
        chunk.content = this.getContent(i);
      }
      chunks[i] = chunk;
    }
    return chunks;
  }

  static async write(cacheDir, chunks, {
    contentCacheEntries,
    getContent,
  } = {}) {
    ensureLittleEndian();
    const { vectorsPath, recordsPath, contentPath, filesPath } = BinaryVectorStore.getPaths(cacheDir);

    const tmpSuffix = `.tmp-${process.pid}`;
    const vectorsTmp = `${vectorsPath}${tmpSuffix}`;
    const recordsTmp = `${recordsPath}${tmpSuffix}`;
    const contentTmp = `${contentPath}${tmpSuffix}`;
    const filesTmp = `${filesPath}${tmpSuffix}`;

    const fileIds = new Map();
    const files = [];
    let dim = null;

    const recordEntries = new Array(chunks.length);
    let contentOffset = 0;

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (!chunk) continue;

      const file = chunk.file;
      if (!fileIds.has(file)) {
        fileIds.set(file, files.length);
        files.push(file);
      }

      const vector = chunk.vector instanceof Float32Array ? chunk.vector : new Float32Array(chunk.vector);
      if (!vector) {
        throw new Error('Missing vector data for binary cache write');
      }
      if (dim === null) {
        dim = vector.length;
      } else if (vector.length !== dim) {
        throw new Error('Vector dimension mismatch in binary cache write');
      }

      const contentValue = getContent ? normalizeContent(getContent(chunk, i)) : normalizeContent(chunk.content);
      const contentLength = Buffer.byteLength(contentValue, 'utf-8');

      recordEntries[i] = {
        fileId: fileIds.get(file),
        startLine: chunk.startLine ?? 0,
        endLine: chunk.endLine ?? 0,
        contentOffset,
        contentLength,
        contentValue,
        vector,
      };

      contentOffset += contentLength;
    }

    if (!dim) dim = 0;
    const count = chunks.length;

    await fs.writeFile(filesTmp, JSON.stringify(files, null, 2));

    const vectorsHandle = await fs.open(vectorsTmp, 'w');
    const recordsHandle = await fs.open(recordsTmp, 'w');
    const contentHandle = await fs.open(contentTmp, 'w');

    try {
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

        const vectorBuffer = Buffer.from(entry.vector.buffer, entry.vector.byteOffset, entry.vector.byteLength);
        await vectorsHandle.write(vectorBuffer, 0, vectorBuffer.length, vectorPos);
        vectorPos += vectorBuffer.length;

        if (entry.contentLength > 0) {
          const contentBuffer = Buffer.from(entry.contentValue, 'utf-8');
          await contentHandle.write(contentBuffer, 0, contentBuffer.length, contentPos);
          contentPos += contentBuffer.length;
        }
      }
    } finally {
      await Promise.all([vectorsHandle.close(), recordsHandle.close(), contentHandle.close()]);
    }

    await Promise.all([
      fs.rename(vectorsTmp, vectorsPath),
      fs.rename(recordsTmp, recordsPath),
      fs.rename(contentTmp, contentPath),
      fs.rename(filesTmp, filesPath),
    ]);

    return new BinaryVectorStore({
      vectorsBuffer: await fs.readFile(vectorsPath),
      recordsBuffer: await fs.readFile(recordsPath),
      contentBuffer: await fs.readFile(contentPath),
      files,
      dim,
      count,
      contentCacheEntries,
    });
  }
}
