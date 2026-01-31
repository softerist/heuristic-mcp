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
  // Clean up stale PID file if present
  try {
    const raw = await fs.readFile(pidPath, 'utf-8');
    const existingPid = parseInt(String(raw).trim(), 10);
    if (Number.isInteger(existingPid) && !isProcessRunning(existingPid)) {
      await fs.unlink(pidPath).catch(() => {});
    }
  } catch {
    // ignore missing/invalid pid file
  }
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

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // On Windows, EPERM can happen even if process exists.
    if (err && err.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

export async function acquireWorkspaceLock({ cacheDirectory, workspaceDir = null } = {}) {
  if (!cacheDirectory || isTestEnv()) {
    return { acquired: true, lockPath: null };
  }

  await fs.mkdir(cacheDirectory, { recursive: true });
  const lockPath = path.join(cacheDirectory, 'server.lock.json');

  const readLock = async () => {
    try {
      const raw = await fs.readFile(lockPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const existing = await readLock();
  if (existing && Number.isInteger(existing.pid) && isProcessRunning(existing.pid)) {
    return { acquired: false, lockPath, ownerPid: existing.pid, owner: existing };
  }

  if (existing) {
    await fs.unlink(lockPath).catch(() => {});
  }

  const payload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    workspace: workspaceDir || null,
    argv: process.argv.join(' '),
  };

  try {
    const handle = await fs.open(lockPath, 'wx');
    try {
      await handle.writeFile(JSON.stringify(payload), 'utf-8');
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const current = await readLock();
      if (current && Number.isInteger(current.pid) && isProcessRunning(current.pid)) {
        return { acquired: false, lockPath, ownerPid: current.pid, owner: current };
      }
      await fs.unlink(lockPath).catch(() => {});
      return acquireWorkspaceLock({ cacheDirectory, workspaceDir });
    }
    throw err;
  }

  const cleanup = () => {
    try {
      const raw = fsSync.readFileSync(lockPath, 'utf-8');
      const current = JSON.parse(raw);
      if (current && current.pid === process.pid) {
        fsSync.unlinkSync(lockPath);
      }
    } catch {
      // ignore cleanup errors
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  return { acquired: true, lockPath };
}
