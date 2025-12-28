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
  if (platform === 'win32') {
    paths.push({
      name: 'Antigravity',
      path: expandPath('%USERPROFILE%\\.gemini\\antigravity\\mcp_config.json')
    });
  } else {
    paths.push({
      name: 'Antigravity',
      path: expandPath('~/.gemini/antigravity/mcp_config.json')
    });
  }

  // Claude Desktop
  if (platform === 'darwin') {
    paths.push({
      name: 'Claude Desktop',
      path: expandPath('~/Library/Application Support/Claude/claude_desktop_config.json')
    });
  } else if (platform === 'win32') {
    paths.push({
      name: 'Claude Desktop',
      path: expandPath('%APPDATA%\\Claude\\claude_desktop_config.json')
    });
  }

  // Cursor (Cascade) - Settings are usually in settings.json but MCP might have a specific spot?
  // Cursor often uses VS Code's settings.json for some things, but explicit MCP support varies.
  // For now, we'll stick to Antigravity and Claude as confirmed targets.
  // NOTE: If Cursor adds a specific mcp_config, add it here.

  return paths;
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

  console.log(`[Auto-Register] Detecting IDE configurations...`);

  for (const { name, path: configPath } of configPaths) {
    if (filter && name.toLowerCase() !== filter.toLowerCase()) {
      continue;
    }

    try {
      // Check if file exists
      try {
        await fs.access(configPath);
      } catch {
        console.log(`[Auto-Register] Skipped ${name}: Config file not found at ${configPath}`);
        continue;
      }

      // Read config
      const content = await fs.readFile(configPath, 'utf-8');
      let config = {};
      try {
        config = JSON.parse(content);
      } catch (e) {
        console.error(`[Auto-Register] Error parsing ${name} config: ${e.message}`);
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
      console.log(`\x1b[32m[Auto-Register] ✅ Successfully registered with ${name}\x1b[0m`);
      registeredCount++;

    } catch (err) {
      console.error(`[Auto-Register] Failed to register with ${name}: ${err.message}`);
    }
  }

  if (registeredCount === 0) {
    console.log(`[Auto-Register] No compatible IDE configurations found to update.`);
    console.log(`[Auto-Register] Manual Config:\n${JSON.stringify({ mcpServers: { "heuristic-mcp": serverConfig } }, null, 2)}`);
  } else {
    // Friendly Banner (Using console.error to bypass npm stdout suppression)
    console.error('\n\x1b[36m' + '='.repeat(60));
    console.error('   🚀 Heuristic MCP Installed & Configured!   ');
    console.error('='.repeat(60) + '\x1b[0m');
    console.error(`
\x1b[33mACTION REQUIRED:\x1b[0m
1. \x1b[1mRestart your IDE\x1b[0m (or reload the window) to load the new config.
2. The server will start automatically in the background.

\x1b[32mSTATUS:\x1b[0m
- \x1b[1mIndexing:\x1b[0m Will begin immediately after restart.
- \x1b[1mUsage:\x1b[0m You can work while it indexes (it catches up!).
- \x1b[1mLogs:\x1b[0m Check your IDE's MCP logs if you are curious.

\x1b[36mHappy Coding! 🤖\x1b[0m
    `);
  }
}
