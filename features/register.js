import fs from 'fs/promises';
import { writeFileSync } from 'fs';

import path from 'path';
import os from 'os';
import {
  parseJsonc,
  upsertMcpServerEntryInText,
  upsertMcpServerEntryInToml,
} from '../lib/settings-editor.js';

function getUserHomeDir() {
  if (process.platform === 'win32' && process.env.USERPROFILE) {
    return process.env.USERPROFILE;
  }
  return os.homedir();
}


function detectCurrentIDE() {
  
  if (process.env.ANTIGRAVITY_AGENT) {
    return 'Antigravity';
  }
  if (process.env.CURSOR_AGENT) {
    return 'Cursor';
  }
  if (
    process.env.CODEX_THREAD_ID ||
    process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ||
    process.env.CODEX_WORKSPACE
  ) {
    return 'Codex';
  }
  if (process.env.VSCODE_IPC_HOOK || process.env.TERM_PROGRAM === 'vscode') {
    return 'VS Code';
  }
  if (
    process.env.WARP_SESSION_ID ||
    process.env.TERM_PROGRAM === 'WarpTerminal' ||
    process.env.TERM_PROGRAM === 'Warp'
  ) {
    return 'Warp';
  }
  if (process.env.WINDSURF_AGENT || process.env.WINDSURF_WORKSPACE) {
    return 'Windsurf';
  }

  
  return null;
}


function getConfigPaths() {
  const platform = process.platform;
  const home = getUserHomeDir();
  const currentIDE = detectCurrentIDE();
  const allPaths = [];

  
  allPaths.push({
    name: 'Antigravity',
    path: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
    format: 'json',
    canCreate: true,
  });

  
  allPaths.push({
    name: 'Codex',
    path: path.join(home, '.codex', 'config.toml'),
    format: 'toml',
    canCreate: true,
  });

  
  if (platform === 'darwin') {
    allPaths.push({
      name: 'Claude Desktop',
      path: path.join(
        home,
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json'
      ),
      format: 'json',
      canCreate: false,
    });
  } else if (platform === 'win32') {
    allPaths.push({
      name: 'Claude Desktop',
      path: path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json'),
      format: 'json',
      canCreate: false,
    });
  }

  
  if (platform === 'darwin') {
    allPaths.push({
      name: 'Cursor',
      path: path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json'),
      format: 'json',
      canCreate: false,
    });
  } else if (platform === 'win32') {
    allPaths.push({
      name: 'Cursor',
      path: path.join(process.env.APPDATA || '', 'Cursor', 'User', 'settings.json'),
      format: 'json',
      canCreate: false,
    });
  } else {
    allPaths.push({
      name: 'Cursor',
      path: path.join(home, '.config', 'Cursor', 'User', 'settings.json'),
      format: 'json',
      canCreate: false,
    });
  }

  // Cursor global MCP config (discovered by VS Code MCP Discovery)
  allPaths.push({
    name: 'Cursor Global',
    path: path.join(home, '.cursor', 'mcp.json'),
    format: 'json',
    canCreate: false,
    preferredContainerKey: 'mcpServers',
  });

  // Windsurf global MCP config (discovered by VS Code MCP Discovery)
  allPaths.push({
    name: 'Windsurf',
    path: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    format: 'json',
    canCreate: false,
    preferredContainerKey: 'mcpServers',
  });

  
  allPaths.push({
    name: 'Warp',
    path: path.join(home, '.warp', 'mcp_settings.json'),
    format: 'json',
    canCreate: true,
    preferredContainerKey: 'mcpServers',
  });
  if (platform === 'win32') {
    allPaths.push({
      name: 'Warp AppData',
      path: path.join(process.env.APPDATA || '', 'Warp', 'mcp_settings.json'),
      format: 'json',
      canCreate: false,
      preferredContainerKey: 'mcpServers',
    });
  }
  
  
  if (platform === 'darwin') {
    allPaths.push({
      name: 'VS Code',
      path: path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      format: 'json',
      canCreate: false,
      preferredContainerKey: 'servers',
    });
    allPaths.push({
      name: 'VS Code Insiders',
      path: path.join(
        home,
        'Library',
        'Application Support',
        'Code - Insiders',
        'User',
        'mcp.json'
      ),
      format: 'json',
      canCreate: false,
      preferredContainerKey: 'servers',
    });
  } else if (platform === 'win32') {
    allPaths.push({
      name: 'VS Code',
      path: path.join(process.env.APPDATA || '', 'Code', 'User', 'mcp.json'),
      format: 'json',
      canCreate: false,
      preferredContainerKey: 'servers',
    });
    allPaths.push({
      name: 'VS Code Insiders',
      path: path.join(process.env.APPDATA || '', 'Code - Insiders', 'User', 'mcp.json'),
      format: 'json',
      canCreate: false,
      preferredContainerKey: 'servers',
    });
  } else {
    allPaths.push({
      name: 'VS Code',
      path: path.join(home, '.config', 'Code', 'User', 'mcp.json'),
      format: 'json',
      canCreate: false,
      preferredContainerKey: 'servers',
    });
    allPaths.push({
      name: 'VS Code Insiders',
      path: path.join(home, '.config', 'Code - Insiders', 'User', 'mcp.json'),
      format: 'json',
      canCreate: false,
      preferredContainerKey: 'servers',
    });
  }

  
  
  return allPaths.map((entry) => ({
    ...entry,
    canCreate: entry.canCreate || entry.name === currentIDE,
  }));
}


function forceLog(message) {
  try {
    if (process.platform !== 'win32') {
      writeFileSync('/dev/tty', message + '\n');
    } else {
      console.error(message);
    }
  } catch (_e) {
    console.error(message);
  }
}

function normalizeIdeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/[\s_-]+/g, '');
}

function ideMatchesFilter(name, filter) {
  if (!filter) return true;
  const normalizedName = normalizeIdeName(name);
  const normalizedFilter = normalizeIdeName(filter);
  if (!normalizedFilter) return true;

  if (normalizedName === normalizedFilter) return true;
  if (normalizedFilter === 'claude') return normalizedName === 'claudedesktop';
  if (normalizedFilter === 'cursor') {
    return normalizedName === 'cursor' || normalizedName === 'cursorglobal';
  }
  if (normalizedFilter === 'windsurf') {
    return normalizedName === 'windsurf';
  }
  if (normalizedFilter === 'warp') {
    return normalizedName === 'warp' || normalizedName === 'warpappdata';
  }
  if (normalizedFilter === 'vscode') {
    return normalizedName === 'vscode' || normalizedName === 'vscodeinsiders';
  }

  return false;
}

export async function register(filter = null) {
  const currentIDE = detectCurrentIDE();

  
  
  const serverConfig = {
    command: 'heuristic-mcp',
    args: [],
  };

  const configPaths = getConfigPaths();
  let registeredCount = 0;

  forceLog(`[Auto-Register] Detecting IDE configurations...`);

  for (const { name, path: configPath, canCreate, format, preferredContainerKey } of configPaths) {
    if (!ideMatchesFilter(name, filter)) {
      continue;
    }

    try {
      
      let fileExists = true;

      try {
        await fs.access(configPath);
      } catch {
        fileExists = false;

        
        if (canCreate) {
          try {
            await fs.mkdir(path.dirname(configPath), { recursive: true });
            forceLog(`[Auto-Register] Creating ${name} config at ${configPath}`);
          } catch (mkdirErr) {
            forceLog(
              `[Auto-Register] Skipped ${name}: Cannot create config directory: ${mkdirErr.message}`
            );
            continue;
          }
        } else {
          
          continue;
        }
      }

      let content = '';
      if (fileExists) {
        content = await fs.readFile(configPath, 'utf-8');
        if (format === 'json' && content.trim()) {
          const parsed = parseJsonc(content);
          if (!parsed) {
            forceLog(
              `[Auto-Register] Warning: ${name} config is not valid JSON/JSONC; skipping to avoid data loss.`
            );
            continue;
          }
        }
      }

      const updated =
        format === 'toml'
          ? upsertMcpServerEntryInToml(content, 'heuristic-mcp', serverConfig)
          : upsertMcpServerEntryInText(
              content,
              'heuristic-mcp',
              serverConfig,
              preferredContainerKey || 'mcpServers'
            );
      if (!updated) {
        forceLog(
          `[Auto-Register] Warning: Failed to update ${name} config (could not locate root object).`
        );
        continue;
      }

      
      writeFileSync(configPath, updated);

      forceLog(`\x1b[32m[Auto-Register] ✅ Successfully registered with ${name}\x1b[0m`);
      registeredCount++;
    } catch (err) {
      forceLog(`[Auto-Register] Failed to register with ${name}: ${err.message}`);
    }
  }

  if (registeredCount === 0) {
    forceLog(`[Auto-Register] No compatible IDE configurations found to update.`);
    forceLog(
      `[Auto-Register] Manual Config:\n${JSON.stringify({ mcpServers: { 'heuristic-mcp': serverConfig } }, null, 2)}`
    );
  } else {
    
    forceLog('\n\x1b[36m' + '='.repeat(60));
    forceLog('   🚀 Heuristic MCP Installed & Configured!   ');
    forceLog('='.repeat(60) + '\x1b[0m');

    
    const home = getUserHomeDir();
    const cacheRoot =
      process.platform === 'win32'
        ? path.join(
            process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
            'heuristic-mcp'
          )
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
- \x1b[1mMCP Config:\x1b[0m ${configPaths.map((p) => p.path).join(', ')}
- \x1b[1mCache:\x1b[0m ${cacheRoot}
- \x1b[1mCheck status:\x1b[0m heuristic-mcp --status
- \x1b[1mView logs:\x1b[0m heuristic-mcp --logs

\x1b[36mHappy Coding! 🤖\x1b[0m
    `);
    forceLog(`\n\x1b[90m(Please wait while npm finalizes the installation...)\x1b[0m`);
  }

  if (currentIDE === 'Warp' && registeredCount === 0) {
    forceLog(
      '[Auto-Register] Warp detected but no local Warp MCP config was writable. Use Warp MCP settings/UI if needed.'
    );
  }
}
