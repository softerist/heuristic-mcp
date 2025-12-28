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

// Detect which IDE is running the install
function detectCurrentIDE() {
  // Check environment variables to determine which IDE is running
  if (process.env.ANTIGRAVITY_AGENT) {
    return 'Antigravity';
  }
  if (process.env.CURSOR_AGENT) {
    return 'Cursor';
  }
  // Claude Desktop doesn't have a known env var, so we rely on existing config detection
  return null;
}

// Known config paths for different IDEs
function getConfigPaths() {
  const platform = process.platform;
  const home = os.homedir();
  const currentIDE = detectCurrentIDE();
  const allPaths = [];

  // Antigravity - dedicated mcp_config.json
  allPaths.push({
    name: 'Antigravity',
    path: path.join(home, '.gemini', 'antigravity', 'mcp_config.json')
  });

  // Claude Desktop - dedicated config file
  if (platform === 'darwin') {
    allPaths.push({
      name: 'Claude Desktop',
      path: path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    });
  } else if (platform === 'win32') {
    allPaths.push({
      name: 'Claude Desktop',
      path: path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json')
    });
  }

  // Cursor - settings.json with mcpServers key
  if (platform === 'darwin') {
    allPaths.push({
      name: 'Cursor',
      path: path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json')
    });
  } else if (platform === 'win32') {
    allPaths.push({
      name: 'Cursor',
      path: path.join(process.env.APPDATA || '', 'Cursor', 'User', 'settings.json')
    });
  } else {
    allPaths.push({
      name: 'Cursor',
      path: path.join(home, '.config', 'Cursor', 'User', 'settings.json')
    });
  }

  // CONSISTENT LOGIC:
  // - If IDE is detected via env var → return ONLY that IDE, canCreate: true
  // - If no IDE detected → return ALL, canCreate: false (only update existing configs)

  if (currentIDE) {
    // IDE detected - return only that IDE with permission to create
    return allPaths
      .filter(p => p.name === currentIDE)
      .map(p => ({ ...p, canCreate: true }));
  } else {
    // No IDE detected - return all but don't create new configs
    return allPaths.map(p => ({ ...p, canCreate: false }));
  }
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
    args: [scriptPath, "--workspace", "."], // Use . (CWD) to avoid variable expansion issues
    disabled: false,
    autoRegistered: true // Marker to know we did this
  };

  const configPaths = getConfigPaths();
  let registeredCount = 0;

  forceLog(`[Auto-Register] Detecting IDE configurations...`);

  for (const { name, path: configPath, canCreate } of configPaths) {
    if (filter && name.toLowerCase() !== filter.toLowerCase()) {
      continue;
    }

    try {
      // Check if file exists - create if canCreate is true for this IDE
      let config = {};
      let fileExists = true;

      try {
        await fs.access(configPath);
      } catch {
        fileExists = false;

        // Only create config if this IDE allows it (has dedicated MCP config file)
        if (canCreate) {
          try {
            await fs.mkdir(path.dirname(configPath), { recursive: true });
            forceLog(`[Auto-Register] Creating ${name} config at ${configPath}`);
          } catch (mkdirErr) {
            forceLog(`[Auto-Register] Skipped ${name}: Cannot create config directory: ${mkdirErr.message}`);
            continue;
          }
        } else {
          // Skip IDEs that use shared settings files if they don't exist
          continue;
        }
      }

      // Read existing config if file exists
      if (fileExists) {
        const content = await fs.readFile(configPath, 'utf-8');
        try {
          config = JSON.parse(content);
        } catch (e) {
          forceLog(`[Auto-Register] Error parsing ${name} config: ${e.message}`);
          continue;
        }
      }

      // Init mcpServers if missing
      if (!config.mcpServers) {
        config.mcpServers = {};
      }

      // Inject configuration
      config.mcpServers['heuristic-mcp'] = serverConfig;

      // Write back synchronously to avoid race conditions
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
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
