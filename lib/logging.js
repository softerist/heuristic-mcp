import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import util from 'util';

let logStream = null;
const originalConsole = {
  log: console.info,
  warn: console.warn,
  error: console.error,
  info: console.info,
};

export function enableStderrOnlyLogging() {
  // Keep MCP stdout clean by routing all console output to stderr.
  const redirect = (...args) => originalConsole.error(...args);
  // eslint-disable-next-line no-console
  console.log = redirect;
  console.info = redirect;
  console.warn = redirect;
  console.error = redirect;
  // eslint-disable-next-line no-console
  console.log = redirect;
  console.info = redirect;
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
      // Skip empty lines (spacers) in log files
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
      const originalError = originalConsole.error;
      // eslint-disable-next-line no-console
      console[method] = (...args) => {
        // Always send to original stderr to avoid MCP protocol pollution on stdout
        originalError(...args);
        writeLine(level, args);
      };
    };

    wrap('log', 'INFO');
    wrap('warn', 'WARN');
    wrap('error', 'ERROR');
    wrap('info', 'INFO');

    logStream.on('error', (err) => {
      originalConsole.error(`[Logs] Failed to write log file: ${err.message}`);
    });

    process.on('exit', () => {
      if (logStream) logStream.end();
    });

    return logPath;
  } catch (err) {
    originalConsole.error(`[Logs] Failed to initialize log file: ${err.message}`);
    return null;
  }
}

export function getLogFilePath(config) {
  return path.join(config.cacheDirectory, 'logs', 'server.log');
}

export async function ensureLogDirectory(config) {
  const logPath = getLogFilePath(config);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  return logPath;
}

// ============================================================================
// Error Handling Utilities
// ============================================================================

/*
 * Error handling patterns used in this codebase:
 * 
 * SILENT_EXPECTED: Empty catch for expected failures (file not found, cleanup)
 *   Use for: fs.stat on optional files, cleanup on exit, optional features
 * 
 * LOG_AND_CONTINUE: Warn but continue execution
 *   Use for: Non-critical features, fallback scenarios
 * 
 * LOG_AND_RETHROW: Log context then propagate to caller  
 *   Use for: Fatal errors that caller must handle
 * 
 * VERBOSE_ONLY: Only log when verbose mode is enabled
 *   Use for: Performance diagnostics, debug information
 */
export const ERROR_PATTERNS = {
  SILENT_EXPECTED: 'silent_expected',
  LOG_AND_CONTINUE: 'log_and_continue',
  LOG_AND_RETHROW: 'log_and_rethrow',
  VERBOSE_ONLY: 'verbose_only',
};

/**
 * Log message only when verbose mode is enabled.
 * @param {object|boolean} configOrVerbose - Config object with verbose property, or boolean
 * @param  {...any} args - Arguments to log
 */
export function logVerbose(configOrVerbose, ...args) {
  const isVerbose = typeof configOrVerbose === 'boolean' 
    ? configOrVerbose 
    : configOrVerbose?.verbose;
  if (isVerbose) {
    console.info(...args);
  }
}

/**
 * Log a recoverable error with consistent formatting.
 * Use when the error is non-fatal and execution can continue.
 * @param {string} context - Where the error occurred
 * @param {Error} error - The caught error
 * @param {object} options - Optional configuration
 * @param {boolean} options.verbose - If true, log full stack trace
 * @param {string} options.fallbackAction - Description of fallback behavior
 */
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

/**
 * Check if an error is expected and should be silently ignored.
 * @param {Error} error - The caught error
 * @param {string[]} expectedCodes - Expected error codes
 * @returns {boolean} True if error matches an expected code
 */
export function isExpectedError(error, expectedCodes = ['ENOENT', 'ENOTDIR']) {
  return error && typeof error.code === 'string' && expectedCodes.includes(error.code);
}
