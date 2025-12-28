import { exec } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);

export async function stop() {
  console.log('[Lifecycle] Stopping Heuristic MCP servers...');
  try {
    const platform = process.platform;
    let command = '';

    if (platform === 'win32') {
      // Windows: Use wmic to find node processes running our script
      command = `wmic process where "CommandLine like '%heuristic-mcp/index.js%'" delete`;
    } else {
      // Unix/Linux/Mac: Use pkill to find the process matching the script path
      // We exclude the current process to avoid suicide if we are running from the same script
      // however, usually the CLI runner is a different PID than the server.
      command = `pkill -f "heuristic-mcp/index.js"`;
    }

    await execPromise(command);
    console.log('[Lifecycle] ✅ Stopped all running instances.');
  } catch (error) {
    // pkill returns non-zero if no process found, which is fine
    if (error.code === 1 || error.message.includes('No Instance(s) Available')) {
      console.log('[Lifecycle] No running instances found.');
    } else {
      // Don't fail hard, just warn
      console.warn(`[Lifecycle] Note: Could not stop server (it might not be running). Detail: ${error.message}`);
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
