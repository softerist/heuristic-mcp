import fs from 'fs';

function isTypedArray(x) {
  return x && ArrayBuffer.isView(x) && !(x instanceof DataView);
}

function onceDrainOrError(stream) {
  return new Promise((resolve, reject) => {
    const onDrain = () => cleanup(resolve);
    const onError = (err) => cleanup(() => reject(err));

    const cleanup = (fn) => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
      fn();
    };

    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

/**
 * Streaming JSON array writer optimized for:
 * - TypedArray vectors streamed (no per-item vector allocation)
 * - backpressure safety
 * - configurable float rounding + flush threshold
 * - compact mode when indent === '' (no forced newlines)
 * - safe cleanup on failure (abort)
 * - optional native TypedArray.join(',') fast-path when rounding is disabled
 */
export class StreamingJsonWriter {
  /**
   * @param {string} filePath
   * @param {object} [opts]
   * @param {number} [opts.highWaterMark] Stream internal buffer size.
   * @param {number|null} [opts.floatDigits] Round floats to N digits. null disables rounding.
   * @param {number} [opts.flushChars] Flush threshold for the internal string buffer.
   * @param {string} [opts.indent] Indent prefix per item ("" for compact, "  " for pretty).
   * @param {boolean} [opts.assumeFinite] Skip NaN/Infinity checks (unsafe if false data).
   * @param {boolean} [opts.checkFinite] If set, overrides assumeFinite (true = check, false = skip).
   * @param {boolean} [opts.noMutation] Avoid temporary mutation when stripping vector.
   * @param {number} [opts.joinThreshold] Max elements to use single join() string.
   * @param {number} [opts.joinChunkSize] Elements per join() chunk when chunking.
   */
  constructor(
    filePath,
    {
      highWaterMark = 256 * 1024,
      floatDigits = 6,
      flushChars = 256 * 1024,
      indent = '',
      assumeFinite,
      checkFinite,
      noMutation = false,
      joinThreshold = 8192,
      joinChunkSize = 2048,
    } = {},
  ) {
    this.filePath = filePath;
    this.highWaterMark = Number.isInteger(highWaterMark) && highWaterMark > 8 * 1024
      ? highWaterMark
      : 256 * 1024;
    this.flushChars = Number.isInteger(flushChars) && flushChars > 8 * 1024
      ? flushChars
      : 256 * 1024;
    this.indent = typeof indent === 'string' ? indent : '';
    this.pretty = this.indent.length > 0;
    this.assumeFinite =
      typeof checkFinite === 'boolean' ? !checkFinite : !!assumeFinite;
    this.noMutation = !!noMutation;
    this.joinThreshold = Number.isInteger(joinThreshold) && joinThreshold > 0
      ? joinThreshold
      : 8192;
    this.joinChunkSize = Number.isInteger(joinChunkSize) && joinChunkSize > 0
      ? joinChunkSize
      : 2048;

    this._prefixFirst = this.pretty ? this.indent : '';
    this._prefixNext = this.pretty ? ',\n' + this.indent : ',';

    this.stream = null;
    this.first = true;
    this._streamError = null;

    // Formatter + fast-path flag
    this._useJoinFastPath = floatDigits === null;

    if (!this._useJoinFastPath) {
      const digitsOk = Number.isInteger(floatDigits) && floatDigits >= 0 && floatDigits <= 12;
      const d = digitsOk ? floatDigits : 6;
      const scale = 10 ** d;
      if (this.assumeFinite) {
        this._formatFn = (x) => String(Math.round(x * scale) / scale);
      } else {
        this._formatFn = (x) => {
          if (!Number.isFinite(x)) return '0';
          return String(Math.round(x * scale) / scale);
        };
      }
    } else {
      if (this.assumeFinite) {
        this._formatFn = (x) => String(x);
      } else {
        this._formatFn = (x) => {
          if (!Number.isFinite(x)) return '0';
          return String(x);
        };
      }
    }
  }

  async writeStart() {
    if (this.stream) return;

    this.stream = fs.createWriteStream(this.filePath, {
      flags: 'w',
      encoding: 'utf8',
      highWaterMark: this.highWaterMark,
    });

    this.stream.on('error', (err) => {
      this._streamError = err;
    });

    await new Promise((resolve, reject) => {
      if (this.stream.fd !== null) return resolve();
      this.stream.once('open', resolve);
      this.stream.once('error', reject);
    });

    const p = this._writeRaw(this.pretty ? '[\n' : '[');
    if (p) await p;
    this.first = true;
  }

  /**
   * Best-effort early shutdown (use in catch/finally blocks).
   * Destroys the stream to avoid fd leaks when writeEnd() is not reached.
   */
  abort(err) {
    if (!this.stream) return;
    try {
      this._streamError = err || this._streamError || new Error('StreamingJsonWriter aborted');
      this.stream.destroy(this._streamError);
    } catch {
      // ignore
    } finally {
      this.stream = null;
    }
  }

  async drain() {
    if (!this.stream || !this.stream.writableNeedDrain) return;
    await onceDrainOrError(this.stream);
  }

  writeItem(item) {
    if (!this.stream) throw new Error('StreamingJsonWriter not started. Call writeStart() first.');
    if (this._streamError) throw this._streamError;

    const prefix = this.first ? this._prefixFirst : this._prefixNext;
    this.first = false;

    const vec = item?.vector;

    if (isTypedArray(vec)) {
      const base = this.noMutation
        ? this._stringifyWithoutMutation(item, vec)
        : this._stringifyWithoutVector(item, vec);
      const hasBase = typeof base === 'string' && base.length > 0 && base !== '{}';
      const header = hasBase
        ? `${prefix}${base.slice(0, -1)},"vector":`
        : `${prefix}{"vector":`;

      return this._chain(this._writeRaw(header), () =>
        this._chain(this._writeTypedArray(vec), () => this._writeRaw('}')),
      );
    }

    return this._writeRaw(prefix + JSON.stringify(item));
  }

  async writeEnd() {
    if (!this.stream) return;
    if (this._streamError) throw this._streamError;

    const p = this._writeRaw(this.pretty ? '\n]\n' : ']\n');
    if (p) await p;

    await new Promise((resolve, reject) => {
      this.stream.once('error', reject);
      this.stream.end(resolve);
    });

    this.stream = null;
    this._streamError = null;
  }

  _chain(promise, next) {
    if (promise) return promise.then(() => next());
    return next();
  }

  _stringifyWithoutVector(item, vec) {
    let base;
    let restored = false;

    try {
      const prev = item.vector;
      item.vector = undefined;
      base = JSON.stringify(item);
      item.vector = prev;
      restored = true;
    } catch {
      base = JSON.stringify(item, (key, val) =>
        key === 'vector' && val === vec ? undefined : val,
      );
    } finally {
      if (!restored) {
        try {
          item.vector = vec;
        } catch {
          // ignore
        }
      }
    }

    return base;
  }

  _stringifyWithoutMutation(item, vec) {
    try {
      const rest = { ...item };
      delete rest.vector;
      return JSON.stringify(rest);
    } catch {
      return JSON.stringify(item, (key, val) =>
        key === 'vector' && val === vec ? undefined : val,
      );
    }
  }

  /**
   * Core write method.
   * Returns null on synchronous success (fast path).
   * Returns a Promise only when backpressure is hit (slow path).
   */
  _writeRaw(str) {
    if (this._streamError) throw this._streamError;

    const ok = this.stream.write(str);
    if (ok) return null;

    return onceDrainOrError(this.stream).then(() => {
      if (this._streamError) throw this._streamError;
    });
  }

  _writeTypedArray(vec) {
    return this._chain(this._writeRaw('['), () => this._writeTypedArrayBody(vec));
  }

  _writeTypedArrayBody(vec) {
    if (this._useJoinFastPath) {
      if (!this.assumeFinite && !this._allFinite(vec)) {
        return this._writeFormatted(vec);
      }

      if (vec.length <= this.joinThreshold) {
        return this._chain(this._writeRaw(vec.join(',')), () => this._writeRaw(']'));
      }

      return this._writeJoinChunks(vec);
    }

    return this._writeFormatted(vec);
  }

  _allFinite(vec) {
    for (let i = 0; i < vec.length; i++) {
      if (!Number.isFinite(vec[i])) return false;
    }
    return true;
  }

  _writeJoinChunks(vec) {
    const len = vec.length;
    if (len === 0) return this._writeRaw(']');

    let i = 0;
    const chunkSize = this.joinChunkSize;

    const writeNext = () => {
      while (i < len) {
        const end = Math.min(len, i + chunkSize);
        let chunk = vec.subarray(i, end).join(',');
        if (i !== 0) chunk = ',' + chunk;
        i = end;

        const pending = this._writeRaw(chunk);
        if (pending) return pending.then(writeNext);
      }

      return this._writeRaw(']');
    };

    return writeNext();
  }

  _writeFormatted(vec) {
    const len = vec.length;
    if (len === 0) return this._writeRaw(']');

    let i = 0;
    let buf = '';
    const FLUSH_AT = this.flushChars;
    const format = this._formatFn;

    const writeNext = () => {
      while (i < len) {
        if (i) buf += ',';
        buf += format(vec[i]);
        i += 1;

        if (buf.length >= FLUSH_AT) {
          const pending = this._writeRaw(buf);
          buf = '';
          if (pending) return pending.then(writeNext);
        }
      }

      if (buf) {
        const pending = this._writeRaw(buf);
        buf = '';
        if (pending) return pending.then(() => this._writeRaw(']'));
      }

      return this._writeRaw(']');
    };

    return writeNext();
  }
}
