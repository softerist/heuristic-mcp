import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { crc32 } from 'zlib';
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
const TELEMETRY_FILE = 'binary-store-telemetry.json';
const RETRYABLE_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const BINARY_ARTIFACT_BASE_FILES = [VECTORS_FILE, RECORDS_FILE, CONTENT_FILE, FILES_FILE];
const STARTUP_TMP_CLEANUP_MIN_AGE_MS = 2 * 60 * 1000;
const TELEMETRY_VERSION = 1;

function createTelemetryTotals() {
  return {
    atomicReplaceAttempts: 0,
    atomicReplaceSuccesses: 0,
    atomicReplaceFailures: 0,
    renameRetryCount: 0,
    fallbackCopyCount: 0,
    rollbackCount: 0,
    rollbackRestoreFailureCount: 0,
    startupCleanupRuns: 0,
    staleTempFilesRemoved: 0,
    staleTempFilesSkippedActive: 0,
  };
}

function normalizeTelemetry(raw) {
  const totals = createTelemetryTotals();
  if (raw?.totals && typeof raw.totals === 'object') {
    for (const key of Object.keys(totals)) {
      if (Number.isFinite(raw.totals[key])) {
        totals[key] = raw.totals[key];
      }
    }
  }
  return {
    version: TELEMETRY_VERSION,
    totals,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    lastError:
      raw?.lastError && typeof raw.lastError === 'object'
        ? {
            at: typeof raw.lastError.at === 'string' ? raw.lastError.at : null,
            message:
              typeof raw.lastError.message === 'string' ? raw.lastError.message : null,
          }
        : null,
    lastAtomicReplace:
      raw?.lastAtomicReplace && typeof raw.lastAtomicReplace === 'object'
        ? { ...raw.lastAtomicReplace }
        : null,
    lastStartupCleanup:
      raw?.lastStartupCleanup && typeof raw.lastStartupCleanup === 'object'
        ? { ...raw.lastStartupCleanup }
        : null,
  };
}

async function readTelemetryFile(cacheDir) {
  const telemetryPath = path.join(cacheDir, TELEMETRY_FILE);
  try {
    const raw = await fs.readFile(telemetryPath, 'utf-8');
    return normalizeTelemetry(JSON.parse(raw));
  } catch {
    return normalizeTelemetry(null);
  }
}

async function writeTelemetryFile(cacheDir, telemetry) {
  const telemetryPath = path.join(cacheDir, TELEMETRY_FILE);
  await fs.mkdir(cacheDir, { recursive: true }).catch(() => {});
  await fs.writeFile(telemetryPath, JSON.stringify(telemetry, null, 2));
}

async function updateTelemetry(cacheDir, mutate) {
  if (!cacheDir) return;
  try {
    const telemetry = await readTelemetryFile(cacheDir);
    mutate(telemetry);
    telemetry.updatedAt = new Date().toISOString();
    await writeTelemetryFile(cacheDir, telemetry);
  } catch {
    
  }
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function parsePidFromBinaryArtifact(fileName) {
  const match = fileName.match(/\.(?:tmp|bak)-(\d+)(?:-|$)/);
  if (!match) return null;
  const pid = Number.parseInt(match[1], 10);
  return Number.isInteger(pid) ? pid : null;
}

function isBinaryTempArtifact(fileName) {
  return BINARY_ARTIFACT_BASE_FILES.some(
    (baseFile) =>
      fileName.startsWith(`${baseFile}.tmp-`) || fileName.startsWith(`${baseFile}.bak-`)
  );
}

function addToMetric(metrics, key, value = 1) {
  if (!metrics || !Number.isFinite(value) || value <= 0) return;
  metrics[key] = (metrics[key] || 0) + value;
}

export async function readBinaryStoreTelemetry(cacheDir) {
  return readTelemetryFile(cacheDir);
}

export async function cleanupStaleBinaryArtifacts(
  cacheDir,
  { minAgeMs = STARTUP_TMP_CLEANUP_MIN_AGE_MS, logger = null } = {}
) {
  const result = {
    cacheDir,
    scanned: 0,
    removed: 0,
    skippedActive: 0,
    removedFiles: [],
  };

  let entries = [];
  try {
    entries = await fs.readdir(cacheDir, { withFileTypes: true });
  } catch {
    return result;
  }

  const now = Date.now();
  for (const entry of entries) {
    const fileName = typeof entry === 'string' ? entry : entry?.name;
    if (!fileName) continue;
    const isFileEntry = typeof entry === 'string' ? true : entry?.isFile?.() === true;
    if (!isFileEntry) continue;
    if (!isBinaryTempArtifact(fileName)) continue;
    result.scanned += 1;

    const fullPath = path.join(cacheDir, fileName);
    const stats = await fs.stat(fullPath).catch(() => null);
    if (!stats) continue;

    const ageMs = now - stats.mtimeMs;
    const ownerPid = parsePidFromBinaryArtifact(fileName);
    if (ownerPid && isProcessRunning(ownerPid)) {
      result.skippedActive += 1;
      continue;
    }
    if (ageMs < minAgeMs) continue;

    await fs.rm(fullPath, { force: true }).catch(() => {});
    result.removed += 1;
    result.removedFiles.push(fileName);
  }

  await updateTelemetry(cacheDir, (telemetry) => {
    telemetry.totals.startupCleanupRuns += 1;
    telemetry.totals.staleTempFilesRemoved += result.removed;
    telemetry.totals.staleTempFilesSkippedActive += result.skippedActive;
    telemetry.lastStartupCleanup = {
      at: new Date().toISOString(),
      scanned: result.scanned,
      removed: result.removed,
      skippedActive: result.skippedActive,
    };
  });

  if (logger && result.removed > 0) {
    logger.info(
      `[Cache] Startup temp cleanup removed ${result.removed} stale artifact(s) from ${cacheDir}`
    );
  }

  return result;
}

function isRetryableRenameError(err) {
  return RETRYABLE_RENAME_ERRORS.has(err?.code);
}

async function renameWithRetry(
  source,
  target,
  { retries = 12, delayMs = 50, maxDelayMs = 1000 } = {}
) {
  let attempt = 0;
  let delay = delayMs;
  while (true) {
    try {
      await fs.rename(source, target);
      return attempt;
    } catch (err) {
      if (!isRetryableRenameError(err) || attempt >= retries) {
        err.renameRetryCount = attempt;
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt += 1;
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function removeIfExists(filePath) {
  await fs.rm(filePath, { force: true }).catch(() => {});
}

async function promoteFileWithFallback(source, target, renameOptions = {}, metrics = null) {
  try {
    const retriesUsed = await renameWithRetry(source, target, renameOptions);
    addToMetric(metrics, 'renameRetryCount', retriesUsed);
    return;
  } catch (renameError) {
    const retriesUsed = Number.isFinite(renameError?.renameRetryCount)
      ? renameError.renameRetryCount
      : 0;
    addToMetric(metrics, 'renameRetryCount', retriesUsed);
    if (!isRetryableRenameError(renameError)) {
      throw renameError;
    }

    try {
      await fs.copyFile(source, target);
      await removeIfExists(source);
      addToMetric(metrics, 'fallbackCopyCount', 1);
      return;
    } catch (copyError) {
      const wrapped = new Error(
        `rename failed (${renameError.message}); fallback copy failed (${copyError.message})`
      );
      wrapped.code = copyError?.code || renameError?.code;
      throw wrapped;
    }
  }
}

async function replaceFilesAtomically(filePairs, renameOptions = {}) {
  const metrics = createTelemetryTotals();
  metrics.atomicReplaceAttempts = 1;
  const cacheDir = filePairs.length > 0 ? path.dirname(filePairs[0].target) : null;
  const backupSuffix = `.bak-${process.pid}-${Date.now()}`;
  const backups = [];
  const replacedTargets = [];
  let operationError = null;

  try {
    // Stage current files as backups first. If this fails, nothing is replaced.
    for (const pair of filePairs) {
      if (!(await pathExists(pair.target))) continue;
      const backupPath = `${pair.target}${backupSuffix}`;
      await removeIfExists(backupPath);
      await promoteFileWithFallback(pair.target, backupPath, renameOptions, metrics);
      backups.push({ target: pair.target, backupPath });
    }

    // Replace targets with new temp files.
    for (const pair of filePairs) {
      await promoteFileWithFallback(pair.source, pair.target, renameOptions, metrics);
      replacedTargets.push(pair.target);
    }
    metrics.atomicReplaceSuccesses = 1;
  } catch (error) {
    operationError = error;
    metrics.atomicReplaceFailures = 1;
    metrics.rollbackCount = 1;
    const rollbackErrors = [];

    // Remove any partially replaced files before restoring backups.
    for (const target of replacedTargets.reverse()) {
      await removeIfExists(target);
    }

    // Restore original files from backups.
    for (const backup of backups.reverse()) {
      try {
        await promoteFileWithFallback(backup.backupPath, backup.target, renameOptions, metrics);
      } catch (restoreErr) {
        rollbackErrors.push(
          `restore ${path.basename(backup.target)} failed: ${restoreErr.message}`
        );
      }
    }
    if (rollbackErrors.length > 0) {
      metrics.rollbackRestoreFailureCount = rollbackErrors.length;
    }

    // Clean up temp files left from this failed write attempt.
    await Promise.all(filePairs.map((pair) => removeIfExists(pair.source)));

    if (rollbackErrors.length > 0) {
      error.message = `${error.message}. Rollback issues: ${rollbackErrors.join('; ')}`;
    }
    throw error;
  } finally {
    // Best-effort cleanup for any backup remnants after success/rollback.
    await Promise.all(backups.map((backup) => removeIfExists(backup.backupPath)));
    await updateTelemetry(cacheDir, (telemetry) => {
      telemetry.totals.atomicReplaceAttempts += metrics.atomicReplaceAttempts;
      telemetry.totals.atomicReplaceSuccesses += metrics.atomicReplaceSuccesses;
      telemetry.totals.atomicReplaceFailures += metrics.atomicReplaceFailures;
      telemetry.totals.renameRetryCount += metrics.renameRetryCount;
      telemetry.totals.fallbackCopyCount += metrics.fallbackCopyCount;
      telemetry.totals.rollbackCount += metrics.rollbackCount;
      telemetry.totals.rollbackRestoreFailureCount += metrics.rollbackRestoreFailureCount;
      telemetry.lastAtomicReplace = {
        at: new Date().toISOString(),
        success: metrics.atomicReplaceSuccesses > 0,
        renameRetryCount: metrics.renameRetryCount,
        fallbackCopyCount: metrics.fallbackCopyCount,
        rollbackCount: metrics.rollbackCount,
        rollbackRestoreFailureCount: metrics.rollbackRestoreFailureCount,
      };
      if (operationError) {
        telemetry.lastError = {
          at: new Date().toISOString(),
          message: operationError.message,
        };
      }
    });
  }
}

/**
 * Custom error for binary store corruption.
 * Allows cache layer to distinguish corruption from other load failures.
 */
export class BinaryStoreCorruptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BinaryStoreCorruptionError';
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

/**
 * Generate a random writeId shared across all files in a single write operation.
 */
function generateWriteId() {
  return crypto.randomInt(1, 0xFFFFFFFF);
}

/**
 * Compute CRC32 checksum over a buffer.
 */
function computeCrc32(buffer, initial) {
  return initial !== undefined ? crc32(buffer, initial) >>> 0 : crc32(buffer) >>> 0;
}

function updateCrc32(checksum, buffer) {
  return crc32(buffer, checksum >>> 0) >>> 0;
}

async function computeHandleCrc32(handle, startOffset, totalBytes) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  const chunkSize = Math.min(1024 * 1024, totalBytes);
  const buffer = Buffer.allocUnsafe(chunkSize);
  let checksum = 0;
  let remaining = totalBytes;
  let position = startOffset;

  while (remaining > 0) {
    const toRead = Math.min(buffer.length, remaining);
    const { bytesRead } = await handle.read(buffer, 0, toRead, position);
    if (bytesRead !== toRead) {
      throw new BinaryStoreCorruptionError(
        'Binary store content file truncated during CRC validation'
      );
    }
    checksum = updateCrc32(checksum, buffer.subarray(0, bytesRead));
    remaining -= bytesRead;
    position += bytesRead;
  }

  return checksum >>> 0;
}

async function writeHeaderCrc(handle, crcValue) {
  const crcBuffer = Buffer.alloc(4);
  const crcView = getDataView(crcBuffer);
  crcView.setUint32(0, crcValue >>> 0, true);
  await handle.write(crcBuffer, 0, crcBuffer.length, 20);
}

function readHeader(buffer, magic, headerSize) {
  if (buffer.length < headerSize) {
    throw new BinaryStoreCorruptionError('Binary store header is truncated');
  }
  const actualMagic = readMagic(buffer);
  if (actualMagic !== magic) {
    throw new BinaryStoreCorruptionError(`Invalid binary store magic (${actualMagic})`);
  }
  const view = getDataView(buffer);
  const version = view.getUint32(4, true);
  if (version !== STORE_VERSION) {
    throw new Error(`Unsupported binary store version (${version})`);
  }
  return view;
}

function writeVectorsHeader(buffer, dim, count, writeId) {
  writeMagic(buffer, MAGIC_VECTORS);
  const view = getDataView(buffer);
  view.setUint32(4, STORE_VERSION, true);
  view.setUint32(8, dim, true);
  view.setUint32(12, count, true);
  view.setUint32(16, writeId, true);
  view.setUint32(20, 0, true); // CRC32 placeholder — filled after payload write
  // bytes 24-31: reserved
}

function writeRecordsHeader(buffer, count, fileCount, writeId) {
  writeMagic(buffer, MAGIC_RECORDS);
  const view = getDataView(buffer);
  view.setUint32(4, STORE_VERSION, true);
  view.setUint32(8, count, true);
  view.setUint32(12, fileCount, true);
  view.setUint32(16, writeId, true);
  view.setUint32(20, 0, true); // CRC32 placeholder
  // bytes 24-31: reserved
}

function writeContentHeader(buffer, totalBytes, writeId) {
  writeMagic(buffer, MAGIC_CONTENT);
  const view = getDataView(buffer);
  view.setUint32(4, STORE_VERSION, true);
  const value = BigInt(totalBytes);
  view.setBigUint64(8, value, true);
  view.setUint32(16, writeId, true);
  view.setUint32(20, 0, true); // CRC32 placeholder
  // bytes 24-31: reserved
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
      const vectorsWriteId = vectorsView.getUint32(16, true);
      const vectorsExpectedCrc = vectorsView.getUint32(20, true);

      const recordsView = readHeader(recordsBuffer, MAGIC_RECORDS, RECORD_HEADER_SIZE);
      const recordCount = recordsView.getUint32(8, true);
      const fileCount = recordsView.getUint32(12, true);
      const recordsWriteId = recordsView.getUint32(16, true);
      const recordsExpectedCrc = recordsView.getUint32(20, true);

      if (recordCount !== count) {
        throw new BinaryStoreCorruptionError(`Binary store count mismatch (${recordCount} != ${count})`);
      }

      // Validate writeId consistency between vectors and records
      if (vectorsWriteId !== recordsWriteId) {
        throw new BinaryStoreCorruptionError(
          `Binary store writeId mismatch: vectors=${vectorsWriteId}, records=${recordsWriteId}`
        );
      }

      contentReadHandle = await fs.open(contentPath, 'r');
      let totalContentBytes = 0;

      const headerBuffer = Buffer.alloc(CONTENT_HEADER_SIZE);
      const { bytesRead } = await contentReadHandle.read(headerBuffer, 0, CONTENT_HEADER_SIZE, 0);
      if (bytesRead < CONTENT_HEADER_SIZE) {
        throw new BinaryStoreCorruptionError('Binary store content header is truncated');
      }
      const contentView = readHeader(headerBuffer, MAGIC_CONTENT, CONTENT_HEADER_SIZE);
      totalContentBytes = readBigUint(contentView, 8);
      const contentWriteId = contentView.getUint32(16, true);
      const contentExpectedCrc = contentView.getUint32(20, true);
      const stats = await contentReadHandle.stat();
      const expectedContentSize = CONTENT_HEADER_SIZE + totalContentBytes;
      if (stats.size < expectedContentSize) {
        throw new BinaryStoreCorruptionError('Binary store content file truncated');
      }

      // Validate writeId consistency across all three files
      if (vectorsWriteId !== contentWriteId) {
        throw new BinaryStoreCorruptionError(
          `Binary store writeId mismatch: vectors=${vectorsWriteId}, content=${contentWriteId}`
        );
      }

      // Validate CRC32 for records payload
      const recordsPayload = recordsBuffer.subarray(RECORD_HEADER_SIZE);
      const recordsActualCrc = computeCrc32(recordsPayload);
      if (recordsActualCrc !== recordsExpectedCrc) {
        throw new BinaryStoreCorruptionError(
          `Binary store records CRC32 mismatch (expected ${recordsExpectedCrc}, got ${recordsActualCrc})`
        );
      }

      // Validate CRC32 for vectors payload (only when fully loaded into memory)
      if (!loadVectorsFromDisk) {
        const vectorsPayload = vectorsBuffer.subarray(VECTOR_HEADER_SIZE);
        const vectorsActualCrc = computeCrc32(vectorsPayload);
        if (vectorsActualCrc !== vectorsExpectedCrc) {
          throw new BinaryStoreCorruptionError(
            `Binary store vectors CRC32 mismatch (expected ${vectorsExpectedCrc}, got ${vectorsActualCrc})`
          );
        }
      }

      if (totalContentBytes > 0) {
        const contentActualCrc = await computeHandleCrc32(
          contentReadHandle,
          CONTENT_HEADER_SIZE,
          totalContentBytes
        );
        if (contentActualCrc !== contentExpectedCrc) {
          throw new BinaryStoreCorruptionError(
            `Binary store content CRC32 mismatch (expected ${contentExpectedCrc}, got ${contentActualCrc})`
          );
        }
      } else if (contentExpectedCrc !== 0) {
        throw new BinaryStoreCorruptionError(
          `Binary store content CRC32 mismatch (expected ${contentExpectedCrc}, got 0)`
        );
      }

      const filesData = JSON.parse(filesRaw);
      // Support new format { writeId, files } and legacy raw array
      let files;
      let filesWriteId = null;
      if (filesData && !Array.isArray(filesData) && Array.isArray(filesData.files)) {
        files = filesData.files;
        filesWriteId = filesData.writeId ?? null;
      } else if (Array.isArray(filesData)) {
        files = filesData;
      } else {
        throw new BinaryStoreCorruptionError('Binary store file table is invalid');
      }

      if (files.length !== fileCount) {
        throw new BinaryStoreCorruptionError(
          `Binary store file table count mismatch (${files.length} != ${fileCount})`
        );
      }

      // Validate writeId from files.json if present
      if (filesWriteId !== null && filesWriteId !== vectorsWriteId) {
        throw new BinaryStoreCorruptionError(
          `Binary store writeId mismatch: vectors=${vectorsWriteId}, files.json=${filesWriteId}`
        );
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
      renameOptions,
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

    const writeId = generateWriteId();

    await fs.writeFile(filesTmp, JSON.stringify({ writeId, files }));

    let vectorsHandle = null;
    let recordsHandle = null;
    let contentHandle = null;

    try {
      vectorsHandle = await fs.open(vectorsTmp, 'w');
      recordsHandle = await fs.open(recordsTmp, 'w');
      contentHandle = await fs.open(contentTmp, 'w');

      const vectorsHeader = Buffer.alloc(VECTOR_HEADER_SIZE);
      writeVectorsHeader(vectorsHeader, dim, count, writeId);
      await vectorsHandle.write(vectorsHeader, 0, vectorsHeader.length, 0);

      const recordsHeader = Buffer.alloc(RECORD_HEADER_SIZE);
      writeRecordsHeader(recordsHeader, count, files.length, writeId);
      await recordsHandle.write(recordsHeader, 0, recordsHeader.length, 0);

      const contentHeader = Buffer.alloc(CONTENT_HEADER_SIZE);
      writeContentHeader(contentHeader, contentOffset, writeId);
      await contentHandle.write(contentHeader, 0, contentHeader.length, 0);

      // Incremental CRC32 accumulators (zero-alloc — no read-back needed)
      let vectorsCrc = 0;
      let recordsCrc = 0;
      let contentCrc = 0;

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
        recordsCrc = updateCrc32(recordsCrc, recordBuffer);

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
        vectorsCrc = updateCrc32(vectorsCrc, vectorBuffer);

        if (entry.contentLength > 0) {
          
          const val = await resolveContent(chunk, sourceIndex);
          const contentBuffer = Buffer.from(val, 'utf-8');
          await contentHandle.write(contentBuffer, 0, contentBuffer.length, contentPos);
          contentPos += contentBuffer.length;
          contentCrc = updateCrc32(contentCrc, contentBuffer);
        }
      }

      if (count > 0) {
        await writeHeaderCrc(vectorsHandle, vectorsCrc);
        await writeHeaderCrc(recordsHandle, recordsCrc);
      }
      await writeHeaderCrc(contentHandle, contentCrc);
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

    await replaceFilesAtomically(
      [
        { source: vectorsTmp, target: vectorsPath },
        { source: recordsTmp, target: recordsPath },
        { source: contentTmp, target: contentPath },
        { source: filesTmp, target: filesPath },
      ],
      renameOptions
    );

    return BinaryVectorStore.load(cacheDir, {
      contentCacheEntries,
      vectorCacheEntries,
      vectorLoadMode,
    });
  }
}
