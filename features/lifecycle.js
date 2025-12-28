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
