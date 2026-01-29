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

export function parseArgs(argv = process.argv) {
  const args = argv.slice(2);
  const rawArgs = [...args];

  const wantsVersion = args.includes('--version') || args.includes('-v');
  const wantsHelp = args.includes('--help') || args.includes('-h');
  const wantsStatus = args.includes('--status');
  const wantsClearCache = args.includes('--clear-cache');
  const wantsLogs = args.includes('--logs');
  const wantsStart = args.includes('--start');
  const wantsStop = args.includes('--stop');
  const wantsRegister = args.includes('--register');
  const wantsFix = args.includes('--fix');
  const wantsNoFollow = args.includes('--no-follow');

  const isServerMode = !(
    wantsStatus ||
    wantsClearCache ||
    wantsLogs ||
    wantsStart ||
    wantsStop ||
    wantsRegister ||
    wantsHelp ||
    wantsVersion
  );

  const workspaceDir = parseWorkspaceDir(args);

  let tailLines = DEFAULT_LOG_TAIL_LINES;
  if (wantsLogs) {
    const tailIndex = args.indexOf('--tail');
    if (tailIndex !== -1 && args[tailIndex + 1]) {
      const parsed = parseInt(args[tailIndex + 1], 10);
      if (!isNaN(parsed) && parsed > 0) {
        tailLines = parsed;
      }
    }
  }

  let registerFilter = null;
  if (wantsRegister) {
    const filterIndex = args.indexOf('--register');
    registerFilter =
      args[filterIndex + 1] && !args[filterIndex + 1].startsWith('-')
        ? args[filterIndex + 1]
        : null;
  }

  const knownFlags = new Set([
    '--status',
    '--fix',
    '--clear-cache',
    '--logs',
    '--tail',
    '--no-follow',
    '--start',
    '--stop',
    '--register',
    '--workspace',
    '--version',
    '-v',
    '--help',
    '-h',
  ]);
  const flagsWithValue = new Set(['--tail', '--workspace', '--register']);
  const unknownFlags = collectUnknownFlags(rawArgs, knownFlags, flagsWithValue);

  return {
    args,
    rawArgs,
    isServerMode,
    workspaceDir,
    wantsVersion,
    wantsHelp,
    wantsStatus,
    wantsClearCache,
    wantsLogs,
    wantsStart,
    wantsStop,
    wantsRegister,
    wantsFix,
    wantsNoFollow,
    tailLines,
    registerFilter,
    unknownFlags,
  };
}
