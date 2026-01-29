import { createWriteStream } from 'fs';
import util from 'util';
import { ensureLogDirectory } from './logging.js';

export function createLogger() {
  let logStream = null;
  const originalConsole = {
    log: console.info,
    warn: console.warn,
    error: console.error,
    info: console.info,
  };

  function enableStderrOnlyLogging() {
    // Keep MCP stdout clean by routing all console output to stderr.
    const redirect = (...args) => originalConsole.error(...args);
    console.log = redirect; console.info = redirect;
    console.warn = redirect;
    console.error = redirect;
    console.log = redirect; console.info = redirect;
  }

  async function setupFileLogging(activeConfig) {
    if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
      return null;
    }

    try {
      const logPath = await ensureLogDirectory(activeConfig);
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

  return { originalConsole, enableStderrOnlyLogging, setupFileLogging };
}
