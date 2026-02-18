export const DEFAULT_LOG_TAIL_LINES = 200;

export function printHelp(defaultTailLines = DEFAULT_LOG_TAIL_LINES) {
  console.info(`Heuristic MCP Server

Usage:
  heuristic-mcp [options]

Options:
  --cache                  Show cache status and cleanup recommendations (dry-run)
  --cache --clean          Remove stale cache directories (performs cleanup)
  --status                 Show server status and cache summary
  --clear <cache_id>       Remove a specific cache by ID
  --clear-cache            Remove cache for current workspace (and stale global caches)
  --logs                   Tail server logs (defaults to last 200 lines, follows)
  --mem                    Show last memory snapshot from logs (requires verbose logging)
  --tail <lines>           Lines to show with --logs (default: ${defaultTailLines})
  --no-follow              Do not follow log output with --logs
  --start [ide]            Register + enable in IDE config (antigravity|codex|cursor|vscode|windsurf|warp|"Claude Desktop")
  --stop                   Stop running server instances
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
    console.error(
      `[Server] IDE variable not expanded: ${rawWorkspace}, falling back to auto-detected workspace`
    );
    return null;
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
  const wantsCache = args.includes('--cache');
  const wantsClean = args.includes('--clean');
  const wantsStatus = args.includes('--status');
  const wantsClearCache = args.includes('--clear-cache');
  const wantsLogs = args.includes('--logs');
  const wantsMem = args.includes('--mem');
  const wantsRegister = args.includes('--register');
  const wantsStart = args.includes('--start') || wantsRegister;
  const wantsStop = args.includes('--stop');
  const wantsFix = args.includes('--fix');
  const wantsNoFollow = args.includes('--no-follow');

  const isServerMode = !(
    wantsCache ||
    wantsStatus ||
    wantsClearCache ||
    wantsLogs ||
    wantsMem ||
    wantsStart ||
    wantsStop ||
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

  let startFilter = null;
  if (wantsStart) {
    const getFilter = (flag) => {
      const filterIndex = args.indexOf(flag);
      if (filterIndex === -1) return null;
      const value = args[filterIndex + 1];
      return value && !value.startsWith('-') ? value : null;
    };
    startFilter = getFilter('--start') ?? getFilter('--register');
  }

  const knownFlags = new Set([
    '--cache',
    '--clean',
    '--status',
    '--clear',
    '--clear-cache',
    '--logs',
    '--mem',
    '--tail',
    '--no-follow',
    '--start',
    '--stop',
    '--workspace',
    '--version',
    '-v',
    '--help',
    '-h',
  ]);
  const flagsWithValue = new Set(['--tail', '--workspace', '--start', '--register']);
  const unknownFlags = collectUnknownFlags(rawArgs, knownFlags, flagsWithValue);

  return {
    args,
    rawArgs,
    isServerMode,
    workspaceDir,
    wantsVersion,
    wantsHelp,
    wantsCache,
    wantsClean,
    wantsStatus,
    wantsClearCache,
    wantsLogs,
    wantsMem,
    wantsStart,
    wantsStop,
    wantsFix,
    wantsNoFollow,
    tailLines,
    startFilter,
    unknownFlags,
  };
}
