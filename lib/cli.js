export const DEFAULT_LOG_TAIL_LINES = 200;

export function printHelp(defaultTailLines = DEFAULT_LOG_TAIL_LINES) {
  console.info(`Heuristic MCP Server

Usage:
  heuristic-mcp [options]

Options:
  --status                 Show server and cache status
  --fix                    With --status, remove stale cache directories
  --clear-cache            Remove cache for current workspace (and stale global caches)
  --logs                   Tail server logs (defaults to last 200 lines, follows)
  --tail <lines>           Lines to show with --logs (default: ${defaultTailLines})
  --no-follow              Do not follow log output with --logs
  --start                  Ensure IDE config is registered (does not start server)
  --stop                   Stop running server instances
  --register [ide]         Register MCP server with IDE (antigravity|cursor|"Claude Desktop")
  --workspace <path>       Workspace path (used by IDE launch / log viewer)
  --version, -v            Show version
  --help, -h               Show this help
`);
}

export function parseWorkspaceDir(args) {
  const workspaceIndex = args.findIndex((arg) => arg.startsWith('--workspace'));
  if (workspaceIndex === -1) return null;

  const arg = args[workspaceIndex];
  let rawWorkspace = null;

  if (arg.includes('=')) {
    rawWorkspace = arg.split('=')[1];
  } else if (workspaceIndex + 1 < args.length) {
    rawWorkspace = args[workspaceIndex + 1];
  }

  // Check if IDE variable wasn't expanded (contains ${})
  if (rawWorkspace && rawWorkspace.includes('${')) {
    console.error(`[Server] IDE variable not expanded: ${rawWorkspace}, using current directory`);
    return process.cwd();
  }

  return rawWorkspace || null;
}

export function collectUnknownFlags(rawArgs, knownFlags, flagsWithValue) {
  const unknownFlags = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (flagsWithValue.has(arg)) {
      if (arg.includes('=')) continue;
      const next = rawArgs[i + 1];
      if (next && !next.startsWith('-')) {
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('-') && !knownFlags.has(arg) && !arg.startsWith('--workspace=')) {
      unknownFlags.push(arg);
    }
  }
  return unknownFlags;
}
