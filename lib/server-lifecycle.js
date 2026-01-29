import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';

function isTestEnv() {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
}

export async function setupPidFile({ pidFileName = '.heuristic-mcp.pid' } = {}) {
  if (isTestEnv()) {
    return null;
  }

  const pidPath = path.join(os.homedir(), pidFileName);
  try {
    await fs.writeFile(pidPath, `${process.pid}`, 'utf-8');
  } catch (err) {
    console.error(`[Server] Warning: Failed to write PID file: ${err.message}`);
    return null;
  }

  const cleanup = () => {
    try {
      fsSync.unlinkSync(pidPath);
    } catch {
      // ignore
    }
  };

  process.on('exit', cleanup);
  return pidPath;
}

export function registerSignalHandlers(handler) {
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}
