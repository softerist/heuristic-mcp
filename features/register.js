import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// Helper to expand ~ and %vars%
function expandPath(p) {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }

  if (process.platform === 'win32') {
    return p.replace(/%([^%]+)%/g, (_, n) => process.env[n] || '%' + n + '%');
  }

  return p;
}

// Known config paths for different IDEs
function getConfigPaths() {
  const platform = process.platform;
  const home = os.homedir();
  const paths = [];

  // Antigravity
  paths.push({
    name: 'Antigravity',
    path: path.join(home, '.gemini', 'antigravity', 'mcp_config.json')
  });

  // Claude Desktop
  if (platform === 'darwin') {
    paths.push({
      name: 'Claude Desktop',
      path: path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    });
  } else if (platform === 'win32') {
    paths.push({
      name: 'Claude Desktop',
      path: path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json')
    });
  }

  // VS Code (MCP extension config in settings.json)
  if (platform === 'darwin') {
    paths.push({
      name: 'VS Code',
      path: path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
    });
  } else if (platform === 'win32') {
    paths.push({
      name: 'VS Code',
      path: path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json')
    });
  } else {
    paths.push({
      name: 'VS Code',
      path: path.join(home, '.config', 'Code', 'User', 'settings.json')
    });
  }

  // Cursor (uses similar structure to VS Code)
  if (platform === 'darwin') {
    paths.push({
      name: 'Cursor',
      path: path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json')
    });
  } else if (platform === 'win32') {
    paths.push({
      name: 'Cursor',
      path: path.join(process.env.APPDATA || '', 'Cursor', 'User', 'settings.json')
    });
  } else {
    paths.push({
      name: 'Cursor',
      path: path.join(home, '.config', 'Cursor', 'User', 'settings.json')
    });
  }

  return paths;
}

// Helper to force output to terminal, bypassing npm's silence
function forceLog(message) {
  try {
    if (process.platform !== 'win32') {
      fs.writeFileSync('/dev/tty', message + '\n');
    } else {
      console.error(message);
    }
  } catch (e) {
    console.error(message);
  }
}

export async function register(filter = null) {
  const binaryPath = process.execPath; // The node binary
  const scriptPath = fileURLToPath(new URL('../index.js', import.meta.url)); // Absolute path to index.js

  const serverConfig = {
    command: binaryPath,
    args: [scriptPath, "--workspace", "${workspaceFolder}"],
    disabled: false,
    autoRegistered: true // Marker to know we did this
  };

  const configPaths = getConfigPaths();
  let registeredCount = 0;

  forceLog(`[Auto-Register] Detecting IDE configurations...`);

  for (const { name, path: configPath } of configPaths) {
    if (filter && name.toLowerCase() !== filter.toLowerCase()) {
      continue;
    }

    try {
      // Check if file exists
      try {
        await fs.access(configPath);
      } catch {
        // forceLog(`[Auto-Register] Skipped ${name}: Config file not found at ${configPath}`);
        continue;
      }

      // Read config
      const content = await fs.readFile(configPath, 'utf-8');
      let config = {};
      try {
        config = JSON.parse(content);
      } catch (e) {
        forceLog(`[Auto-Register] Error parsing ${name} config: ${e.message}`);
        continue;
      }

      // Init mcpServers if missing
      if (!config.mcpServers) {
        config.mcpServers = {};
      }

      // Inject configuration
      config.mcpServers['heuristic-mcp'] = serverConfig;

      // Write back
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
      forceLog(`\x1b[32m[Auto-Register] ✅ Successfully registered with ${name}\x1b[0m`);
      registeredCount++;

    } catch (err) {
      forceLog(`[Auto-Register] Failed to register with ${name}: ${err.message}`);
    }
  }

  if (registeredCount === 0) {
    forceLog(`[Auto-Register] No compatible IDE configurations found to update.`);
    forceLog(`[Auto-Register] Manual Config:\n${JSON.stringify({ mcpServers: { "heuristic-mcp": serverConfig } }, null, 2)}`);
  } else {
    // Friendly Banner (Using forceLog to bypass npm stdout suppression)
    forceLog('\n\x1b[36m' + '='.repeat(60));
    forceLog('   🚀 Heuristic MCP Installed & Configured!   ');
    forceLog('='.repeat(60) + '\x1b[0m');

    // Show important paths
    const home = os.homedir();
    const cacheRoot = process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'heuristic-mcp')
        : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Caches', 'heuristic-mcp')
        : path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'heuristic-mcp');

    forceLog(`
\x1b[33mACTION REQUIRED:\x1b[0m
1. \x1b[1mRestart your IDE\x1b[0m (or reload the window) to load the new config.
2. The server will start automatically in the background.

\x1b[32mSTATUS:\x1b[0m
- \x1b[1mConfig:\x1b[0m Updated ${registeredCount} config file(s).
- \x1b[1mIndexing:\x1b[0m Will begin immediately after restart.
- \x1b[1mUsage:\x1b[0m You can work while it indexes (it catches up!).

\x1b[90mPATHS:\x1b[0m
- \x1b[1mMCP Config:\x1b[0m ${configPaths.map(p => p.path).join(', ')}
- \x1b[1mCache:\x1b[0m ${cacheRoot}
- \x1b[1mCheck status:\x1b[0m heuristic-mcp --logs

\x1b[36mHappy Coding! 🤖\x1b[0m
    `);
    forceLog(`\n\x1b[90m(Please wait while npm finalizes the installation...)\x1b[0m`);
  }
}
