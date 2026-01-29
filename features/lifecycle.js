/* eslint-disable no-console */
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import fsSync from 'fs';
import { loadConfig } from '../lib/config.js';
import { getLogFilePath } from '../lib/logging.js';
import { clearStaleCaches } from '../lib/cache-utils.js';

const execPromise = util.promisify(exec);

export async function stop() {
  console.info('[Lifecycle] Stopping Heuristic MCP servers...');
  try {
    const platform = process.platform;
    const currentPid = process.pid;
    let pids = [];
    const cmdByPid = new Map();
    const manualPid = process.env.HEURISTIC_MCP_PID;

    if (platform === 'win32') {
      // 1. Try PID file first for reliability
      const home = os.homedir();
      const pidFile = path.join(home, '.heuristic-mcp.pid');
      try {
        const content = await fs.readFile(pidFile, 'utf-8');
        const p = content.trim();
        if (p && !isNaN(p)) {
          const pid = parseInt(p, 10);
          if (pid !== currentPid) {
            try {
              process.kill(pid, 0);
              pids.push(p);
            } catch (e) {
              // If we lack permission, still attempt to stop by PID.
              if (e.code === 'EPERM') {
                pids.push(p);
              } else {
                // Stale PID file
                await fs.unlink(pidFile).catch(() => {});
              }
            }
          }
        }
      } catch (_e) {
        // Fallback to WMIC when CIM access is denied
        try {
          const { stdout } = await execPromise(
            `wmic process where "CommandLine like '%heuristic-mcp%'" get ProcessId /FORMAT:LIST`
          );
          const matches = stdout.match(/ProcessId=(\d+)/g) || [];
          for (const match of matches) {
            const pid = match.replace('ProcessId=', '');
            if (pid && !isNaN(pid) && parseInt(pid, 10) !== currentPid) {
              if (!pids.includes(pid)) pids.push(pid);
            }
          }
        } catch (_wmicErr) {
          // ignore secondary failures
        }
      }

      // 2. Fallback to process list with fuzzier matching (kill all heuristic-mcp instances)
      try {
        const { stdout } = await execPromise(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*heuristic-mcp*' -or $_.CommandLine -like '*heuristic-mcp\\\\index.js*' -or $_.CommandLine -like '*heuristic-mcp/index.js*') } | Select-Object -ExpandProperty ProcessId"`
        );
        const listPids = stdout
          .trim()
          .split(/\s+/)
          .filter((p) => p && !isNaN(p) && parseInt(p) !== currentPid);
        
        for (const p of listPids) {
          if (!pids.includes(p)) pids.push(p);
        }
      } catch (_e) { /* ignore */ }
    } else {
      // Unix: Use pgrep to get all matching PIDs
      try {
        const { stdout } = await execPromise(`pgrep -f "heuristic-mcp"`);
        const allPids = stdout
          .trim()
          .split(/\s+/)
          .filter((p) => p && !isNaN(p));

        // Filter out current PID and dead processes
        pids = [];
        for (const p of allPids) {
          const pid = parseInt(p);
          if (pid === currentPid) continue;
          try {
            process.kill(pid, 0);
            pids.push(p);
          } catch (_e) { /* ignore */ }
        }
      } catch (e) {
        // pgrep returns code 1 if no processes found, which is fine
        if (e.code === 1) pids = [];
        else throw e;
      }
    }

    // Manual PID override (best-effort)
    if (manualPid) {
      const parts = String(manualPid)
        .split(/[,\s]+/)
        .map((part) => part.trim())
        .filter(Boolean);
      for (const part of parts) {
        if (!isNaN(part)) {
          const pidValue = String(parseInt(part, 10));
          if (pidValue && !pids.includes(pidValue)) {
            pids.push(pidValue);
          }
        }
      }
    }

    if (pids.length === 0) {
      console.info('[Lifecycle] No running instances found (already stopped).');
      await setMcpServerEnabled(false);
      return;
    }

    // Capture command lines before killing (best-effort)
    try {
      if (platform === 'win32') {
        const { stdout } = await execPromise(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @(${pids.join(',')}) } | Select-Object ProcessId, CommandLine"`
        );
        const lines = stdout.trim().split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('ProcessId')) continue;
          const match = trimmed.match(/^(\d+)\s+(.*)$/);
          if (match) {
            cmdByPid.set(parseInt(match[1], 10), match[2]);
          }
        }
      } else {
        const { stdout } = await execPromise(`ps -o pid=,command= -p ${pids.join(',')}`);
        const lines = stdout.trim().split(/\r?\n/);
        for (const line of lines) {
          const match = line.trim().match(/^(\d+)\s+(.*)$/);
          if (match) {
            cmdByPid.set(parseInt(match[1], 10), match[2]);
          }
        }
      }
    } catch (_e) {
      // ignore command line lookup failures
    }

    // Kill each process (Windows uses taskkill for compatibility)
    let killedCount = 0;
    const killedPids = [];
    const failedPids = [];
    for (const pid of pids) {
      try {
        if (platform === 'win32') {
          try {
            await execPromise(`taskkill /PID ${pid} /T`);
          } catch (e) {
            const message = String(e?.message || '');
            if (message.includes('not found') || message.includes('not be found')) {
              // Process already exited; treat as success.
              killedCount++;
              killedPids.push(pid);
              continue;
            }
            try {
              await execPromise(`taskkill /PID ${pid} /T /F`);
            } catch (e2) {
              const message2 = String(e2?.message || '');
              if (message2.includes('not found') || message2.includes('not be found')) {
                killedCount++;
                killedPids.push(pid);
                continue;
              }
              throw e2;
            }
          }
        } else {
          process.kill(parseInt(pid), 'SIGTERM');
        }
        killedCount++;
        killedPids.push(pid);
      } catch (e) {
        // Ignore if process already gone
        if (e.code !== 'ESRCH') {
          failedPids.push(pid);
          console.warn(`[Lifecycle] Failed to kill PID ${pid}: ${e.message}`);
        }
      }
    }

    console.info(`[Lifecycle] ✅ Stopped ${killedCount} running instance(s).`);
    if (killedPids.length > 0) {
      console.info('[Lifecycle] Killed processes:');
      for (const pid of killedPids) {
        const cmd = cmdByPid.get(parseInt(pid, 10));
        if (cmd) {
          console.info(`   ${pid}: ${cmd}`);
        } else {
          console.info(`   ${pid}`);
        }
      }
    }
    if (failedPids.length > 0) {
      console.info('[Lifecycle] Failed to kill:');
      for (const pid of failedPids) {
        const cmd = cmdByPid.get(parseInt(pid, 10));
        if (cmd) {
          console.info(`   ${pid}: ${cmd}`);
        } else {
          console.info(`   ${pid}`);
        }
      }
    }

    await setMcpServerEnabled(false);
  } catch (error) {
    console.warn(`[Lifecycle] Warning: Stop command encountered an error: ${error.message}`);
  }
}

export async function start() {
  console.info('[Lifecycle] Ensuring server is configured...');
  // Re-use the registration logic to ensure the config is present and correct
  try {
    const { register } = await import('./register.js');
    await register();
    await setMcpServerEnabled(true);
    console.info('[Lifecycle] ✅ Configuration checked.');
    console.info(
      '[Lifecycle] To start the server, please reload your IDE window or restart the IDE.'
    );
  } catch (err) {
    console.error(`[Lifecycle] Failed to configure server: ${err.message}`);
  }
}

async function setMcpServerEnabled(enabled) {
  const paths = getMcpConfigPaths();
  const target = 'heuristic-mcp';
  let changed = 0;

  for (const { name, path: configPath, settingsMode } of paths) {
    try {
      await fs.access(configPath);
    } catch {
      continue;
    }

    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const config = raw && raw.trim() ? JSON.parse(raw) : {};
      const updated = settingsMode
        ? updateSettingsMcpServer(config, target, enabled)
        : updateMcpServers(config, target, enabled);
      if (!updated) continue;
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
      changed++;
    } catch (err) {
      console.warn(`[Lifecycle] Failed to update ${name} config: ${err.message}`);
    }
  }

  if (changed > 0) {
    console.info(
      `[Lifecycle] MCP server ${enabled ? 'enabled' : 'disabled'} in ${changed} config file(s).`
    );
  }
}

function updateMcpServers(config, target, enabled) {
  if (!config.mcpServers || !config.mcpServers[target]) return false;
  config.mcpServers[target].disabled = !enabled;
  return true;
}

function updateSettingsMcpServer(config, target, enabled) {
  const candidateKeys = ['mcpServers', 'cline.mcpServers'];
  let updated = false;
  for (const key of candidateKeys) {
    const current = getNestedValue(config, key);
    if (current && current[target]) {
      current[target].disabled = !enabled;
      updated = true;
    }
  }
  return updated;
}

function getNestedValue(obj, key) {
  if (!obj || !key) return null;
  const parts = key.split('.');
  let current = obj;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return null;
    current = current[part];
  }
  return current;
}

function getMcpConfigPaths() {
  const home = os.homedir();
  const configLocations = [
    {
      name: 'Antigravity',
      path: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
    },
    {
      name: 'Claude Desktop',
      path: path.join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    },
    {
      name: 'VS Code',
      path: path.join(home, '.config', 'Code', 'User', 'settings.json'),
      settingsMode: true,
    },
    {
      name: 'Cursor',
      path: path.join(home, '.config', 'Cursor', 'User', 'settings.json'),
    },
  ];

  if (process.platform === 'darwin') {
    configLocations[1].path = path.join(
      home,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
    configLocations[2].path = path.join(
      home,
      'Library',
      'Application Support',
      'Code',
      'User',
      'settings.json'
    );
    configLocations[3].path = path.join(
      home,
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'settings.json'
    );
  } else if (process.platform === 'win32') {
    configLocations[1].path = path.join(
      process.env.APPDATA || '',
      'Claude',
      'claude_desktop_config.json'
    );
    configLocations[2].path = path.join(
      process.env.APPDATA || '',
      'Code',
      'User',
      'settings.json'
    );
    configLocations[3].path = path.join(
      process.env.APPDATA || '',
      'Cursor',
      'User',
      'settings.json'
    );
  }

  return configLocations;
}

async function readTail(filePath, maxLines) {
  const data = await fs.readFile(filePath, 'utf-8');
  if (!data) return '';
  const lines = data.split(/\r?\n/);
  const tail = lines.slice(-maxLines).join('\n');
  return tail.trimEnd();
}

async function followFile(filePath, startPosition) {
  let position = startPosition;
  const watcher = fsSync.watch(filePath, { persistent: true }, async (event) => {
    if (event !== 'change') return;
    try {
      const stats = await fs.stat(filePath);
      if (stats.size < position) {
        position = 0;
      }
      if (stats.size === position) return;
      const stream = fsSync.createReadStream(filePath, { start: position, end: stats.size - 1 });
      stream.pipe(process.stdout, { end: false });
      position = stats.size;
    } catch {
      // ignore read errors while watching
    }
  });

  const stop = () => {
    watcher.close();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toLocaleString()} (${date.toISOString()})`;
}

export async function logs({ workspaceDir = null, tailLines = 200, follow = true } = {}) {
  const config = await loadConfig(workspaceDir);
  const logPath = getLogFilePath(config);

  try {
    const stats = await fs.stat(logPath);
    const tail = await readTail(logPath, tailLines);
    if (tail) {
      process.stdout.write(tail + '\n');
    }

    if (!follow) {
      return;
    }

    console.info(`[Logs] Following ${logPath} (Ctrl+C to stop)...`);
    await followFile(logPath, stats.size);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`[Logs] No log file found for workspace.`);
      console.error(`[Logs] Expected location: ${logPath}`);
      console.error(`[Logs] Start the server from your IDE, then run: heuristic-mcp --logs`);
      return;
    }
    console.error(`[Logs] Failed to read log file: ${err.message}`);
  }
}

// Helper to get global cache dir
function getGlobalCacheDir() {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  } else if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches');
  }
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
}

export async function status({ fix = false } = {}) {
  try {
    const home = os.homedir();
    const pids = [];
    const now = new Date();

    // 1. Check PID file first
    const pidFile = path.join(home, '.heuristic-mcp.pid');

    try {
      const content = await fs.readFile(pidFile, 'utf-8');
      const pid = parseInt(content.trim(), 10);
      if (pid && !isNaN(pid)) {
        // Check if running
        try {
          process.kill(pid, 0);
          pids.push(pid);
        } catch (_e) {
          // Stale PID file
          await fs.unlink(pidFile).catch(() => {});
        }
      }
    } catch (_e) {
      // No pid file, ignore
    }

    // 2. Fallback to process list if no PID file found or process dead
    if (pids.length === 0) {
      try {
        const myPid = process.pid;
        if (process.platform === 'win32') {
          const { stdout } = await execPromise(
            `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"CommandLine LIKE '%heuristic-mcp%index.js%'\\" | Select-Object -ExpandProperty ProcessId"`
          );
          const winPids = stdout
            .trim()
            .split(/\s+/)
            .filter((p) => p && !isNaN(p));

          for (const p of winPids) {
            const pid = parseInt(p, 10);
            if (pid && pid !== myPid) {
              if (!pids.includes(pid)) pids.push(pid);
            }
          }
        } else {
          const { stdout } = await execPromise('ps aux');
          const lines = stdout.split('\n');
          const validPids = [];

          for (const line of lines) {
            if (line.includes('heuristic-mcp/index.js') || line.includes('heuristic-mcp')) {
              const parts = line.trim().split(/\s+/);
              const pid = parseInt(parts[1], 10);
              if (pid && !isNaN(pid) && pid !== myPid && !line.includes(' grep ')) {
                validPids.push(pid);
              }
            }
          }
          // Merge validPids into pids if not already present
          for (const p of validPids) {
            if (!pids.includes(p)) pids.push(p);
          }
        }
      } catch (_e) { /* ignore */ }
    }

    // STATUS OUTPUT
    console.info(''); // spacer
    if (pids.length > 0) {
      console.info(`[Lifecycle] 🟢 Server is RUNNING. PID(s): ${pids.join(', ')}`);
    } else {
      console.info('[Lifecycle] ⚪ Server is STOPPED.');
    }
    if (pids.length > 1) {
      console.info('[Lifecycle] ⚠️  Multiple servers detected; progress may be inconsistent.');
    }
    if (pids.length > 0) {
      const cmdByPid = new Map();
      try {
        if (process.platform === 'win32') {
          const { stdout } = await execPromise(
            `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @(${pids.join(',')}) } | Select-Object ProcessId, CommandLine"`
          );
          const lines = stdout.trim().split(/\r?\n/);
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('ProcessId')) continue;
            const match = trimmed.match(/^(\d+)\s+(.*)$/);
            if (match) {
              cmdByPid.set(parseInt(match[1], 10), match[2]);
            }
          }
        } else {
          const { stdout } = await execPromise(`ps -o pid=,command= -p ${pids.join(',')}`);
          const lines = stdout.trim().split(/\r?\n/);
          for (const line of lines) {
            const match = line.trim().match(/^(\d+)\s+(.*)$/);
            if (match) {
              cmdByPid.set(parseInt(match[1], 10), match[2]);
            }
          }
        }
      } catch (_e) {
        // ignore command line lookup failures
      }
      if (cmdByPid.size > 0) {
        console.info('[Lifecycle] Active command lines:');
        for (const pid of pids) {
          const cmd = cmdByPid.get(pid);
          if (cmd) {
            console.info(`   ${pid}: ${cmd}`);
          }
        }
      }
    }
    console.info(''); // spacer

    // APPEND LOGS INFO (Cache Status)
    const globalCacheRoot = path.join(getGlobalCacheDir(), 'heuristic-mcp');
    console.info('[Status] Inspecting cache status...\n');

    if (fix) {
      console.info('[Status] Fixing stale caches...\n');
      await clearStaleCaches();
    }

    const cacheDirs = await fs.readdir(globalCacheRoot).catch(() => []);

    if (cacheDirs.length === 0) {
      console.info('[Status] No cache directories found.');
      console.info(`[Status] Expected location: ${globalCacheRoot}`);
    } else {
      console.info(
        `[Status] Found ${cacheDirs.length} cache director${cacheDirs.length === 1 ? 'y' : 'ies'} in ${globalCacheRoot}`
      );

      for (const dir of cacheDirs) {
        const cacheDir = path.join(globalCacheRoot, dir);
        const metaFile = path.join(cacheDir, 'meta.json');
        const progressFile = path.join(cacheDir, 'progress.json');

          console.info(`${'─'.repeat(60)}`);
          console.info(`📁 Cache: ${dir}`);
          console.info(`   Path: ${cacheDir}`);

        let metaData = null;
        try {
          metaData = JSON.parse(await fs.readFile(metaFile, 'utf-8'));

          console.info(`   Status: ✅ Valid cache`);
          console.info(`   Workspace: ${metaData.workspace || 'Unknown'}`);
          console.info(`   Files indexed: ${metaData.filesIndexed ?? 'N/A'}`);
          console.info(`   Chunks stored: ${metaData.chunksStored ?? 'N/A'}`);

          if (Number.isFinite(metaData.lastDiscoveredFiles)) {
            console.info(`   Files discovered (last run): ${metaData.lastDiscoveredFiles}`);
          }
          if (Number.isFinite(metaData.lastFilesProcessed)) {
            console.info(`   Files processed (last run): ${metaData.lastFilesProcessed}`);
          }
          if (
            Number.isFinite(metaData.lastDiscoveredFiles) &&
            Number.isFinite(metaData.lastFilesProcessed)
          ) {
            const delta = metaData.lastDiscoveredFiles - metaData.lastFilesProcessed;
            console.info(`   Discovery delta (last run): ${delta >= 0 ? delta : 0}`);
          }

          if (metaData.lastSaveTime) {
            const saveDate = new Date(metaData.lastSaveTime);
            const ageMs = now - saveDate;
            const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
            const ageMins = Math.floor((ageMs % (1000 * 60 * 60)) / (1000 * 60));
            console.info(
              `   Cached snapshot saved: ${formatDateTime(saveDate)} (${ageHours}h ${ageMins}m ago)`
            );
            const ageLabel = formatDurationMs(ageMs);
            if (ageLabel) {
              console.info(`   Cached snapshot age: ${ageLabel}`);
            }
            console.info(`   Initial index complete at: ${formatDateTime(saveDate)}`);
          }
          if (metaData.lastIndexStartedAt) {
            console.info(
              `   Last index started: ${formatDateTime(metaData.lastIndexStartedAt)}`
            );
          }
          if (metaData.lastIndexEndedAt) {
            console.info(
              `   Last index ended: ${formatDateTime(metaData.lastIndexEndedAt)}`
            );
          }
          if (Number.isFinite(metaData.indexDurationMs)) {
            const duration = formatDurationMs(metaData.indexDurationMs);
            if (duration) {
              console.info(`   Last full index duration: ${duration}`);
            }
          }
          if (metaData.lastIndexMode) {
            console.info(`   Last index mode: ${String(metaData.lastIndexMode)}`);
          }
          if (Number.isFinite(metaData.lastBatchSize)) {
            console.info(`   Last batch size: ${metaData.lastBatchSize}`);
          }
          if (Number.isFinite(metaData.lastWorkerThreads)) {
            console.info(`   Last worker threads: ${metaData.lastWorkerThreads}`);
          }
          try {
            const dirStats = await fs.stat(cacheDir);
            console.info(
              `   Cache dir last write: ${formatDateTime(dirStats.mtime)}`
            );
          } catch {
            // ignore cache dir stat errors
          }

          // Verify indexing completion
          if (metaData.filesIndexed && metaData.filesIndexed > 0) {
            console.info(`   Cached index: ✅ COMPLETE (${metaData.filesIndexed} files)`);
          } else if (metaData.filesIndexed === 0) {
            console.info(`   Cached index: ⚠️  NO FILES (check excludePatterns)`);
          } else {
            console.info(`   Cached index: ⚠️  INCOMPLETE`);
          }
        } catch (err) {
          if (err.code === 'ENOENT') {
            try {
              const stats = await fs.stat(cacheDir);
              const ageMs = new Date() - stats.mtime;
              if (ageMs < 10 * 60 * 1000) {
                console.info(`   Status: ⏳ Initializing / Indexing in progress...`);
                console.info(`   (Metadata file has not been written yet using ID ${dir})`);
                console.info('   Initial index: ⏳ IN PROGRESS');
              } else {
                console.info(`   Status: ⚠️  Incomplete cache (stale)`);
              }
              console.info(
                `   Cache dir last write: ${stats.mtime.toLocaleString()}`
              );
            } catch {
              console.info(`   Status: ❌ Invalid cache directory`);
            }
          } else {
            console.info(`   Status: ❌ Invalid or corrupted (${err.message})`);
          }
        }

        // Show latest indexing progress if available
        let progressData = null;
        try {
          progressData = JSON.parse(await fs.readFile(progressFile, 'utf-8'));
        } catch {
          // no progress file
        }

        if (progressData && typeof progressData.progress === 'number') {
          const updatedAt = progressData.updatedAt
            ? formatDateTime(progressData.updatedAt)
            : 'Unknown';
          const progressLabel = metaData
            ? 'Incremental update (post-snapshot)'
            : 'Initial index progress';
          console.info(
            `   ${progressLabel}: ${progressData.progress}/${progressData.total} (${progressData.message || 'n/a'})`
          );
          console.info(`   Progress updated: ${updatedAt}`);

          if (progressData.updatedAt) {
            const updatedDate = new Date(progressData.updatedAt);
            const ageMs = now - updatedDate;
            const staleMs = 5 * 60 * 1000;
            const ageLabel = formatDurationMs(ageMs);
            if (ageLabel) {
              console.info(`   Progress age: ${ageLabel}`);
            }
            if (Number.isFinite(ageMs) && ageMs > staleMs) {
              const staleLabel = formatDurationMs(ageMs);
              console.info(`   Progress stale: last update ${staleLabel} ago`);
            }
          }

          if (progressData.updatedAt && metaData?.lastSaveTime) {
            const updatedDate = new Date(progressData.updatedAt);
            const saveDate = new Date(metaData.lastSaveTime);
            if (updatedDate > saveDate) {
              console.info('   Note: Incremental update in progress; cached snapshot may lag.');
            }
          }
          if (progressData.indexMode) {
            console.info(`   Current index mode: ${String(progressData.indexMode)}`);
          }
          if (progressData.workerCircuitOpen && Number.isFinite(progressData.workersDisabledUntil)) {
            const remainingMs = progressData.workersDisabledUntil - Date.now();
            const remainingLabel = formatDurationMs(Math.max(0, remainingMs));
            console.info(`   Workers paused: ${remainingLabel || '0s'} remaining`);
            console.info(
              `   Workers disabled until: ${formatDateTime(progressData.workersDisabledUntil)}`
            );
          }
        } else {
          if (metaData) {
            console.info('   Summary: Cached snapshot available; no update running.');
          } else {
            console.info('   Summary: No cached snapshot yet; indexing has not started.');
          }
        }

        if (metaData && progressData && typeof progressData.progress === 'number') {
          console.info('   Indexing state: Cached snapshot available; incremental update running.');
        } else if (metaData) {
          console.info('   Indexing state: Cached snapshot available; idle.');
        } else if (progressData && typeof progressData.progress === 'number') {
          console.info('   Indexing state: Initial index in progress; no cached snapshot yet.');
        } else {
          console.info('   Indexing state: No cached snapshot; idle.');
        }
      }
      console.info(`${'─'.repeat(60)}`);
    }

    // SHOW PATHS
    console.info('\n[Paths] Important locations:');

    // Global npm bin
    let npmBin = 'unknown';
    try {
      const { stdout } = await execPromise('npm config get prefix');
      npmBin = path.join(stdout.trim(), 'bin');
    } catch { /* ignore */ }
    console.info(`   📦 Global npm bin: ${npmBin}`);

    // Configs
    const configLocations = [
      {
        name: 'Antigravity',
        path: path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
      },
      {
        name: 'Cursor',
        path: path.join(os.homedir(), '.config', 'Cursor', 'User', 'settings.json'),
      },
    ];

    // Platform specific logic for Cursor
    if (process.platform === 'darwin') {
      configLocations[1].path = path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'Cursor',
        'User',
        'settings.json'
      );
    } else if (process.platform === 'win32') {
      configLocations[1].path = path.join(
        process.env.APPDATA || '',
        'Cursor',
        'User',
        'settings.json'
      );
    }

    console.info('   ⚙️  MCP configs:');
    for (const loc of configLocations) {
      let status = '(not found)';
      try {
        await fs.access(loc.path);
        status = '(exists)';
      } catch { /* ignore */ }
      console.info(`      - ${loc.name}: ${loc.path} ${status}`);
    }

    console.info(`   💾 Cache root: ${globalCacheRoot}`);
    console.info(`   📁 Current dir: ${process.cwd()}`);
    console.info('');
  } catch (error) {
    console.error(`[Lifecycle] Failed to check status: ${error.message}`);
  }
}
