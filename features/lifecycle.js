import { exec } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);

export async function stop() {
  console.log('[Lifecycle] Stopping Heuristic MCP servers...');
  try {
    const platform = process.platform;
    const currentPid = process.pid;
    let pids = [];

    if (platform === 'win32') {
      const { stdout } = await execPromise(`wmic process where "CommandLine like '%heuristic-mcp/index.js%'" get ProcessId`);
      pids = stdout.trim().split(/\s+/).filter(p => p && !isNaN(p) && parseInt(p) !== currentPid);
    } else {
      // Unix: Use pgrep to get all matching PIDs
      try {
        const { stdout } = await execPromise(`pgrep -f \"heuristic-mcp.*index.js\"`);
        const allPids = stdout.trim().split(/\s+/).filter(p => p && !isNaN(p));

        // Filter out current PID and dead processes
        pids = [];
        for (const p of allPids) {
            const pid = parseInt(p);
            if (pid === currentPid) continue;
            try {
                process.kill(pid, 0);
                pids.push(p);
            } catch (e) {}
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
        console.log('[Lifecycle] To start the server, please reload your IDE window or restart the IDE.');
    } catch (err) {
        console.error(`[Lifecycle] Failed to configure server: ${err.message}`);
    }
}

export async function status() {
    try {
        const platform = process.platform;
        const currentPid = process.pid;
        let pids = [];

        if (platform === 'win32') {
            const { stdout } = await execPromise(`wmic process where "CommandLine like '%heuristic-mcp/index.js%'" get ProcessId`);
            pids = stdout.trim().split(/\s+/).filter(p => p && !isNaN(p) && parseInt(p) !== currentPid);
        } else {
            try {
                const { stdout } = await execPromise(`pgrep -f "heuristic-mcp.*index.js"`);
                const allPids = stdout.trim().split(/\s+/).filter(p => p && !isNaN(p));

                // Filter out current PID and dead processes (e.g. ephemeral shell wrappers)
                const validPids = [];
                for (const p of allPids) {
                    const pid = parseInt(p);
                    if (pid === currentPid) continue;

                    try {
                        // Check if process is still alive
                        process.kill(pid, 0);
                        validPids.push(p);
                    } catch (e) {
                         // Process is dead or access denied
                    }
                }
                pids = validPids;
            } catch (e) {
                if (e.code === 1) pids = [];
                else throw e;
            }
        }

        if (pids.length > 0) {
            console.log(`[Lifecycle] 🟢 Server is RUNNING. PID(s): ${pids.join(', ')}`);
        } else {
            console.log('[Lifecycle] ⚪ Server is STOPPED.');
        }
    } catch (error) {
         console.error(`[Lifecycle] Failed to check status: ${error.message}`);
    }
}

export async function logs() {
    const fs = await import('fs/promises');
    const path = await import('path');
    const os = await import('os');
    const crypto = await import('crypto');

    console.log('[Logs] Searching for cache directories...\n');

    // Determine global cache root
    function getGlobalCacheDir() {
        if (process.platform === 'win32') {
            return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        } else if (process.platform === 'darwin') {
            return path.join(os.homedir(), 'Library', 'Caches');
        }
        return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    }

    const globalCacheRoot = path.join(getGlobalCacheDir(), 'heuristic-mcp');

    try {
        // List all cache directories
        const cacheDirs = await fs.readdir(globalCacheRoot).catch(() => []);

        if (cacheDirs.length === 0) {
            console.log('[Logs] No cache directories found.');
            console.log(`[Logs] Expected location: ${globalCacheRoot}`);
            return;
        }

        console.log(`[Logs] Found ${cacheDirs.length} cache director${cacheDirs.length === 1 ? 'y' : 'ies'} in ${globalCacheRoot}\n`);

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
                console.log(`   Embedding model: ${metaData.embeddingModel}`);

                if (metaData.lastSaveTime) {
                    const saveDate = new Date(metaData.lastSaveTime);
                    const now = new Date();
                    const ageMs = now - saveDate;
                    const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
                    const ageMins = Math.floor((ageMs % (1000 * 60 * 60)) / (1000 * 60));

                    console.log(`   Last saved: ${saveDate.toLocaleString()} (${ageHours}h ${ageMins}m ago)`);
                }

                // Check file sizes
                const files = ['embeddings.json', 'file-hashes.json', 'call-graph.json', 'ann-index.bin'];
                const sizes = [];
                for (const file of files) {
                    try {
                        const stat = await fs.stat(path.join(cacheDir, file));
                        sizes.push(`${file}: ${(stat.size / 1024).toFixed(1)}KB`);
                    } catch {}
                }
                if (sizes.length > 0) {
                    console.log(`   Files: ${sizes.join(', ')}`);
                }

                // Verify indexing completion
                if (metaData.filesIndexed && metaData.filesIndexed > 0 && metaData.chunksStored && metaData.chunksStored > 0) {
                    console.log(`   Indexing: ✅ COMPLETE (${metaData.filesIndexed} files → ${metaData.chunksStored} chunks)`);
                } else if (metaData.filesIndexed === 0) {
                    console.log(`   Indexing: ⚠️  NO FILES (check excludePatterns in config)`);
                } else {
                    console.log(`   Indexing: ⚠️  INCOMPLETE or UNKNOWN`);
                }

            } catch (e) {
                console.log(`   Status: ❌ Invalid or corrupted (${e.message})`);
            }
        }

        console.log(`${'─'.repeat(60)}\n`);

    } catch (error) {
        console.error(`[Logs] Error reading cache: ${error.message}`);
    }
}
