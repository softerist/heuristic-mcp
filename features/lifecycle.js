import { exec } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);

export async function stop() {
  console.log('[Lifecycle] Stopping Heuristic MCP servers...');
  try {
    const platform = process.platform;
    let command = '';
    const currentPid = process.pid;

    if (platform === 'win32') {
      // Windows: Use wmic to find node processes running our script, excluding the current one
      command = `wmic process where "CommandLine like '%heuristic-mcp/index.js%' and ProcessId != ${currentPid}" delete`;
    } else {
      // Unix/Linux/Mac: Use pkill to find the process matching the script path
      // We explicitly exclude the current process PID to avoid suicide
      command = `pkill -f "heuristic-mcp/index.js" --exclude-pids ${currentPid}`;

      // Some pkill versions don't support --exclude-pids, fallback to a more complex pattern
      // that matches the index.js but doesn't match the current command line flags if possible,
      // or just use pgrep to get PIDs and kill them manually.
    }

    try {
      await execPromise(command);
    } catch (e) {
      // If pkill failed because of --exclude-pids, try a safer approach
      if (platform !== 'win32') {
        const fallbackCommand = `pgrep -f "heuristic-mcp/index.js" | grep -v "^${currentPid}$" | xargs -r kill`;
        await execPromise(fallbackCommand);
      } else {
        throw e;
      }
    }

    console.log('[Lifecycle] ✅ Stopped all running instances.');
  } catch (error) {
    // pkill (Linux/Mac) returns exit code 1 if no process matched.
    // We treat exit code 1 as "Success, nothing was running".
    if (error.code === 1 || error.code === '1' || error.message?.includes('No Instance(s) Available')) {
      console.log('[Lifecycle] No running instances found (already stopped).');
    } else {
      // Don't fail hard, just warn
      console.warn(`[Lifecycle] Warning: Stop command finished with unexpected result: ${error.message}`);
    }
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
        let command = '';
        const currentPid = process.pid;

        if (platform === 'win32') {
            command = `wmic process where "CommandLine like '%heuristic-mcp/index.js%' and ProcessId != ${currentPid}" get ProcessId`;
        } else {
            // pgrep -f matches the full command line, we exclude the current PID
            command = `pgrep -f "heuristic-mcp/index.js" | grep -v "^${currentPid}$"`;
        }

        const { stdout } = await execPromise(command);
        const pids = stdout.trim().split(/\s+/).filter(pid => pid && !isNaN(pid));

        if (pids.length > 0) {
            console.log(`[Lifecycle] 🟢 Server is RUNNING. PID(s): ${pids.join(', ')}`);
        } else {
            console.log('[Lifecycle] ⚪ Server is STOPPED.');
        }
    } catch (error) {
        // pgrep returns exit code 1 if no process found
        if (error.code === 1 || error.code === '1' || error.message?.includes('No Instance(s) Available')) {
             console.log('[Lifecycle] ⚪ Server is STOPPED.');
        } else {
             console.error(`[Lifecycle] Failed to check status: ${error.message}`);
        }
    }
}
