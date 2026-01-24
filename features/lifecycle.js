/* eslint-disable no-console */
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import fsSync from 'fs';
import { loadConfig } from '../lib/config.js';
import { getLogFilePath } from '../lib/logging.js';

const execPromise = util.promisify(exec);

export async function stop() {
  console.log('[Lifecycle] Stopping Heuristic MCP servers...');
  try {
    const platform = process.platform;
    const currentPid = process.pid;
    let pids = [];

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
            } catch (_e) {
              // Stale PID file
              await fs.unlink(pidFile).catch(() => {});
            }
          }
        }
      } catch (_e) { /* ignore */ }

      // 2. Fallback to process list with fuzzier matching
      try {
        const { stdout } = await execPromise(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"CommandLine LIKE '%index.js%'\\" | Where-Object { $_.CommandLine -like '*heuristic-mcp*' -or $_.CommandLine -like '*node*' } | Select-Object -ExpandProperty ProcessId"`
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
        const { stdout } = await execPromise(`pgrep -f "heuristic-mcp.*index.js"`);
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

    if (pids.length === 0) {
      console.log('[Lifecycle] No running instances found (already stopped).');
      return;
    }

    // Kill each process
    let killedCount = 0;
    for (const pid of pids) {
      try {
        process.kill(parseInt(pid), 'SIGTERM');
        killedCount++;
      } catch (e) {
        // Ignore if process already gone
        if (e.code !== 'ESRCH') console.warn(`[Lifecycle] Failed to kill PID ${pid}: ${e.message}`);
      }
    }

    console.log(`[Lifecycle] ✅ Stopped ${killedCount} running instance(s).`);
  } catch (error) {
    console.warn(`[Lifecycle] Warning: Stop command encountered an error: ${error.message}`);
  }
}

export async function start() {
  console.log('[Lifecycle] Ensuring server is configured...');
  // Re-use the registration logic to ensure the config is present and correct
  try {
    const { register } = await import('./register.js');
    await register();
    console.log('[Lifecycle] ✅ Configuration checked.');
    console.log(
      '[Lifecycle] To start the server, please reload your IDE window or restart the IDE.'
    );
  } catch (err) {
    console.error(`[Lifecycle] Failed to configure server: ${err.message}`);
  }
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

    console.log(`[Logs] Following ${logPath} (Ctrl+C to stop)...`);
    await followFile(logPath, stats.size);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`[Logs] No log file found for workspace.`);
      console.log(`[Logs] Expected location: ${logPath}`);
      console.log(`[Logs] Start the server from your IDE, then run: heuristic-mcp --logs`);
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

export async function status() {
  try {
    const home = os.homedir();
    const pids = [];

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
    console.log(''); // spacer
    if (pids.length > 0) {
      console.log(`[Lifecycle] 🟢 Server is RUNNING. PID(s): ${pids.join(', ')}`);
    } else {
      console.log('[Lifecycle] ⚪ Server is STOPPED.');
    }
    console.log(''); // spacer

    // APPEND LOGS INFO (Cache Status)
    const globalCacheRoot = path.join(getGlobalCacheDir(), 'heuristic-mcp');
    console.log('[Status] Inspecting cache status...\n');

    const cacheDirs = await fs.readdir(globalCacheRoot).catch(() => []);

    if (cacheDirs.length === 0) {
      console.log('[Status] No cache directories found.');
      console.log(`[Status] Expected location: ${globalCacheRoot}`);
    } else {
      console.log(
        `[Status] Found ${cacheDirs.length} cache director${cacheDirs.length === 1 ? 'y' : 'ies'} in ${globalCacheRoot}`
      );

      for (const dir of cacheDirs) {
        const cacheDir = path.join(globalCacheRoot, dir);
        const metaFile = path.join(cacheDir, 'meta.json');

        console.log(`${'─'.repeat(60)}`);
        console.log(`📁 Cache: ${dir}`);
        console.log(`   Path: ${cacheDir}`);

        try {
          const metaData = JSON.parse(await fs.readFile(metaFile, 'utf-8'));

          console.log(`   Status: ✅ Valid cache`);
          console.log(`   Workspace: ${metaData.workspace || 'Unknown'}`);
          console.log(`   Files indexed: ${metaData.filesIndexed ?? 'N/A'}`);
          console.log(`   Chunks stored: ${metaData.chunksStored ?? 'N/A'}`);

          if (metaData.lastSaveTime) {
            const saveDate = new Date(metaData.lastSaveTime);
            const now = new Date();
            const ageMs = now - saveDate;
            const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
            const ageMins = Math.floor((ageMs % (1000 * 60 * 60)) / (1000 * 60));
            console.log(
              `   Last saved: ${saveDate.toLocaleString()} (${ageHours}h ${ageMins}m ago)`
            );
          }

          // Verify indexing completion
          if (metaData.filesIndexed && metaData.filesIndexed > 0) {
            console.log(`   Indexing: ✅ COMPLETE (${metaData.filesIndexed} files)`);
          } else if (metaData.filesIndexed === 0) {
            console.log(`   Indexing: ⚠️  NO FILES (check excludePatterns)`);
          } else {
            console.log(`   Indexing: ⚠️  INCOMPLETE`);
          }
        } catch (err) {
          if (err.code === 'ENOENT') {
            try {
              const stats = await fs.stat(cacheDir);
              const ageMs = new Date() - stats.mtime;
              if (ageMs < 10 * 60 * 1000) {
                console.log(`   Status: ⏳ Initializing / Indexing in progress...`);
                console.log(`   (Metadata file has not been written yet using ID ${dir})`);
              } else {
                console.log(`   Status: ⚠️  Incomplete cache (stale)`);
              }
            } catch {
              console.log(`   Status: ❌ Invalid cache directory`);
            }
          } else {
            console.log(`   Status: ❌ Invalid or corrupted (${err.message})`);
          }
        }
      }
      console.log(`${'─'.repeat(60)}`);
    }

    // SHOW PATHS
    console.log('\n[Paths] Important locations:');

    // Global npm bin
    let npmBin = 'unknown';
    try {
      const { stdout } = await execPromise('npm config get prefix');
      npmBin = path.join(stdout.trim(), 'bin');
    } catch { /* ignore */ }
    console.log(`   📦 Global npm bin: ${npmBin}`);

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

    console.log('   ⚙️  MCP configs:');
    for (const loc of configLocations) {
      let status = '(not found)';
      try {
        await fs.access(loc.path);
        status = '(exists)';
      } catch { /* ignore */ }
      console.log(`      - ${loc.name}: ${loc.path} ${status}`);
    }

    console.log(`   💾 Cache root: ${globalCacheRoot}`);
    console.log(`   📁 Current dir: ${process.cwd()}`);
    console.log('');
  } catch (error) {
    console.error(`[Lifecycle] Failed to check status: ${error.message}`);
  }
}
