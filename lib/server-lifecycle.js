import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { setTimeout as delay } from 'timers/promises';

function isTestEnv() {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
}

function getPidFilePath({ pidFileName, cacheDirectory }) {
  if (cacheDirectory) {
    return path.join(cacheDirectory, pidFileName);
  }
  return path.join(os.homedir(), pidFileName);
}

export async function setupPidFile({
  pidFileName = '.heuristic-mcp.pid',
  cacheDirectory = null,
} = {}) {
  if (isTestEnv()) {
    return null;
  }

  const pidPath = getPidFilePath({ pidFileName, cacheDirectory });
  if (cacheDirectory) {
    try {
      await fs.mkdir(cacheDirectory, { recursive: true });
    } catch {
      
    }
  }
  
  try {
    const raw = await fs.readFile(pidPath, 'utf-8');
    const existingPid = parseInt(String(raw).trim(), 10);
    if (Number.isInteger(existingPid) && !isProcessRunning(existingPid)) {
      await fs.unlink(pidPath).catch(() => {});
    }
  } catch {
    
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
      
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  return { acquired: true, lockPath };
}

export async function releaseWorkspaceLock({ cacheDirectory } = {}) {
  if (!cacheDirectory || isTestEnv()) {
    return;
  }
  const lockPath = path.join(cacheDirectory, 'server.lock.json');
  try {
    const raw = await fs.readFile(lockPath, 'utf-8');
    const current = JSON.parse(raw);
    if (current && current.pid === process.pid) {
      await fs.unlink(lockPath).catch(() => {});
    }
  } catch {
    
  }
}

async function terminateProcess(pid, { graceMs = 1500 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!isProcessRunning(pid)) return true;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    
  }

  const pollCount = Math.max(1, Math.ceil(graceMs / 100));
  for (let i = 0; i < pollCount; i++) {
    if (!isProcessRunning(pid)) return true;
    await delay(100);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    
  }

  await delay(100);
  return !isProcessRunning(pid);
}

export async function stopOtherHeuristicServers({
  globalCacheRoot = null,
  currentCacheDirectory = null,
} = {}) {
  if (isTestEnv() || !globalCacheRoot) {
    return { killed: [], failed: [] };
  }

  const normalizeForCompare = (value) => {
    if (!value) return '';
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const currentCacheDirResolved = normalizeForCompare(currentCacheDirectory);

  let dirEntries = [];
  try {
    dirEntries = await fs.readdir(globalCacheRoot, { withFileTypes: true });
  } catch {
    return { killed: [], failed: [] };
  }

  const lockOwners = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;
    const cacheDirectory = path.join(globalCacheRoot, entry.name);
    if (currentCacheDirResolved && normalizeForCompare(cacheDirectory) === currentCacheDirResolved) {
      continue;
    }

    const lockPath = path.join(cacheDirectory, 'server.lock.json');
    let lock = null;
    try {
      lock = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
    } catch {
      continue;
    }

    const pid = Number(lock?.pid);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;

    if (!isProcessRunning(pid)) {
      await fs.unlink(lockPath).catch(() => {});
      continue;
    }

    lockOwners.push({
      pid,
      workspace: typeof lock?.workspace === 'string' ? lock.workspace : null,
      cacheDirectory,
    });
  }

  const killed = [];
  const failed = [];
  for (const owner of lockOwners) {
    const terminated = await terminateProcess(owner.pid);
    if (terminated) {
      killed.push(owner);
    } else {
      failed.push(owner);
    }
  }

  return { killed, failed };
}
