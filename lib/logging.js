import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import util from 'util';

let logStream = null;
let stderrWritable = true;
const originalConsole = {
  // eslint-disable-next-line no-console
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
};

function isBrokenPipeError(error) {
  if (!error) return false;
  if (typeof error === 'string') {
    return /(?:^|[\s:])EPIPE(?:[\s:]|$)|broken pipe/i.test(error);
  }
  if (typeof error === 'object') {
    if (error.code === 'EPIPE') return true;
    if (typeof error.message === 'string') {
      return /(?:^|[\s:])EPIPE(?:[\s:]|$)|broken pipe/i.test(error.message);
    }
  }
  return false;
}

function writeToOriginalStderr(...args) {
  if (!stderrWritable) return;
  try {
    originalConsole.error(...args);
  } catch (error) {
    if (isBrokenPipeError(error)) {
      stderrWritable = false;
      return;
    }
    throw error;
  }
}

export function enableStderrOnlyLogging() {
  const redirect = (...args) => writeToOriginalStderr(...args);
  // eslint-disable-next-line no-console
  console.log = redirect;
  console.info = redirect;
  console.warn = redirect;
  console.error = redirect;
}

export async function setupFileLogging(config) {
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
    return null;
  }

  try {
    const logPath = await ensureLogDirectory(config);
    logStream = createWriteStream(logPath, { flags: 'a' });

    const writeLine = (level, args) => {
      if (!logStream) return;
      const message = util.format(...args);

      if (!message.trim()) return;

      const timestamp = new Date().toISOString();
      const lines = message
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
      if (lines.length === 0) return;
      const payload = lines.map((line) => `${timestamp} [${level}] ${line}`).join('\n') + '\n';
      logStream.write(payload);
    };

    const wrap = (method, level) => {
      // eslint-disable-next-line no-console
      console[method] = (...args) => {
        writeToOriginalStderr(...args);
        writeLine(level, args);
      };
    };

    wrap('log', 'INFO');
    wrap('warn', 'WARN');
    wrap('error', 'ERROR');
    wrap('info', 'INFO');

    logStream.on('error', (err) => {
      writeToOriginalStderr(`[Logs] Failed to write log file: ${err.message}`);
    });

    process.on('exit', () => {
      if (logStream) logStream.end();
    });

    return logPath;
  } catch (err) {
    writeToOriginalStderr(`[Logs] Failed to initialize log file: ${err.message}`);
    return null;
  }
}

export async function flushLogs({ close = true, timeoutMs = 1000 } = {}) {
  if (!logStream) return;

  const stream = logStream;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (close && logStream === stream) {
        logStream = null;
      }
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    const onFinished = () => {
      clearTimeout(timer);
      finish();
    };

    try {
      if (close) {
        stream.end(onFinished);
      } else {
        stream.write('', onFinished);
      }
    } catch {
      onFinished();
    }
  });
}

export function getLogFilePath(config) {
  return path.join(config.cacheDirectory, 'logs', 'server.log');
}

export async function ensureLogDirectory(config) {
  const logPath = getLogFilePath(config);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  return logPath;
}

export const ERROR_PATTERNS = {
  SILENT_EXPECTED: 'silent_expected',
  LOG_AND_CONTINUE: 'log_and_continue',
  LOG_AND_RETHROW: 'log_and_rethrow',
  VERBOSE_ONLY: 'verbose_only',
};

export function logVerbose(configOrVerbose, ...args) {
  const isVerbose =
    typeof configOrVerbose === 'boolean' ? configOrVerbose : configOrVerbose?.verbose;
  if (isVerbose) {
    console.info(...args);
  }
}

export function logRecoverableError(context, error, options = {}) {
  const message = error?.message || String(error);
  const prefix = `[${context}]`;

  if (options.fallbackAction) {
    console.warn(`${prefix} ${message}. Fallback: ${options.fallbackAction}`);
  } else {
    console.warn(`${prefix} ${message}`);
  }

  if (options.verbose && error?.stack) {
    console.warn(`${prefix} Stack trace:`, error.stack);
  }
}

export function isExpectedError(error, expectedCodes = ['ENOENT', 'ENOTDIR']) {
  return error && typeof error.code === 'string' && expectedCodes.includes(error.code);
}
