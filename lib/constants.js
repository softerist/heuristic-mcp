






export const WORKSPACE_ENV_VARS = Object.freeze([
  'HEURISTIC_MCP_WORKSPACE',
  'MCP_WORKSPACE',
  'CODEX_WORKSPACE',
  'CODEX_PROJECT_ROOT',
  'CODEX_CWD',
  'WORKSPACE_FOLDER',
  'WORKSPACE_ROOT',
  'CURSOR_WORKSPACE',
  'CLAUDE_WORKSPACE',
  'ANTIGRAVITY_WORKSPACE',
  'INIT_CWD',
]);


export const DYNAMIC_WORKSPACE_ENV_PREFIXES = Object.freeze([
  'CODEX_',
  'ANTIGRAVITY_',
  'CURSOR_',
  'CLAUDE_',
  'WINDSURF_',
  'WARP_',
  'MCP_',
  'VSCODE_',
]);


export const DYNAMIC_WORKSPACE_ENV_PREFIX = DYNAMIC_WORKSPACE_ENV_PREFIXES[0];


export const WORKSPACE_ENV_KEY_PATTERN = /(WORKSPACE|PROJECT|ROOT|CWD|DIR)/i;


export const WORKSPACE_ENV_GENERIC_DISCOVERY_PATTERN = /WORKSPACE/i;






export const MIN_CHUNK_TEXT_LENGTH = 20;


export const MAX_OVERLAP_ITERATIONS = 50;


export const TARGET_TOKEN_RATIO = 0.85;


export const OVERLAP_TOKEN_RATIO = 0.18;






export const CHUNKING_PARAMS_CACHE_SIZE = 100;


export const JSON_WORKER_THRESHOLD_BYTES = 2 * 1024 * 1024; 






export const RESULT_BATCH_SIZE = 25;


export const DEFAULT_INFERENCE_BATCH_SIZE = 4;


export const WORKER_BATCH_TIMEOUT_MS = 300_000; 


export const WORKER_FAILURE_COOLDOWN_MS = 10 * 60 * 1000; 


export const BACKGROUND_INDEX_DELAY_MS = 3000;


export const FILE_STAT_CONCURRENCY_LIMIT = 50;


export const LRU_MAX_ENTRIES = 5000;


export const LRU_TARGET_ENTRIES = 4000;


export const MEMORY_LOG_INTERVAL_MS = 15_000; 


export const SQLITE_FILE_RETRY_DELAY_MS = 50;


export const SQLITE_FILE_RETRY_COUNT = 40;






export const SEARCH_SCORING_BATCH_SIZE = 500;


export const RECENCY_BOOST_MAX_IO_FILES = 1000;


export const MAX_FULL_SCAN_SIZE = 50_000;






export const ANN_DIMENSION_SAMPLE_SIZE = 100;


export const ANN_MIN_CHUNKS_DEFAULT = 5000;


export const HNSWLIB_ERROR_RESET_MS = 5 * 60 * 1000; 


export const DEFAULT_READER_WAIT_TIMEOUT_MS = 5000;






export const EMBEDDING_PROCESS_DEFAULT_GC_RSS_THRESHOLD_MB = 2048;


export const EMBEDDING_PROCESS_DEFAULT_GC_MIN_INTERVAL_MS = 15_000;


export const EMBEDDING_PROCESS_DEFAULT_GC_MAX_REQUESTS_WITHOUT_COLLECTION = 8;


export const EMBEDDING_PROCESS_GC_STATE_INITIAL = Object.freeze({
  lastRunAtMs: 0,
  requestsSinceLastRun: 0,
});






export const BINARY_STORE_VERSION = 1;


export const SQLITE_STORE_VERSION = 1;


export const BINARY_VECTOR_HEADER_SIZE = 20;


export const BINARY_RECORD_HEADER_SIZE = 20;


export const BINARY_CONTENT_HEADER_SIZE = 20;


export const BINARY_RECORD_SIZE = 32;






export const MAX_PENDING_WATCH_EVENTS = 10000;


export const PENDING_WATCH_EVENTS_TRIM_SIZE = 5000;






export const ONNX_THREAD_LIMIT = 2;


export const PARTIAL_MATCH_BOOST = 0.3;


export const TEXT_MATCH_MAX_CANDIDATES = 2000;


export const STAT_CONCURRENCY_LIMIT = 50;


export const SEARCH_BATCH_SIZE = 500;






export const MIME_TYPES = {
  
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.mts': 'text/typescript',
  '.cts': 'text/typescript',

  
  '.json': 'application/json',
  '.json5': 'application/json',
  '.jsonc': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/x-toml',
  '.xml': 'application/xml',
  '.csv': 'text/csv',

  
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xhtml': 'application/xhtml+xml',
  '.css': 'text/css',
  '.scss': 'text/x-scss',
  '.sass': 'text/x-sass',
  '.less': 'text/x-less',
  '.styl': 'text/x-stylus',
  '.vue': 'text/x-vue',
  '.svelte': 'text/x-svelte',
  '.astro': 'text/x-astro',

  
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdx': 'text/markdown',
  '.txt': 'text/plain',
  '.rst': 'text/x-rst',
  '.adoc': 'text/asciidoc',
  '.tex': 'text/x-tex',

  
  '.py': 'text/x-python',
  '.pyw': 'text/x-python',
  '.pyx': 'text/x-cython',

  
  '.rb': 'text/x-ruby',
  '.erb': 'text/x-ruby',
  '.rake': 'text/x-ruby',
  '.gemspec': 'text/x-ruby',

  
  '.go': 'text/x-go',

  
  '.rs': 'text/x-rust',

  
  '.java': 'text/x-java',
  '.kt': 'text/x-kotlin',
  '.kts': 'text/x-kotlin',
  '.groovy': 'text/x-groovy',
  '.scala': 'text/x-scala',
  '.clj': 'text/x-clojure',
  '.cljs': 'text/x-clojure',

  
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.cc': 'text/x-c++',
  '.cxx': 'text/x-c++',
  '.hpp': 'text/x-c++',
  '.hxx': 'text/x-c++',
  '.m': 'text/x-objectivec',
  '.mm': 'text/x-objectivec',

  
  '.cs': 'text/x-csharp',
  '.vb': 'text/x-vb',
  '.fs': 'text/x-fsharp',

  
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
  '.fish': 'text/x-shellscript',
  '.bat': 'text/x-batch',
  '.cmd': 'text/x-batch',
  '.ps1': 'text/x-powershell',
  '.psm1': 'text/x-powershell',

  
  '.sql': 'text/x-sql',
  '.pgsql': 'text/x-sql',
  '.mysql': 'text/x-sql',

  
  '.ini': 'text/x-ini',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.properties': 'text/x-properties',
  '.env': 'text/plain',

  
  '.swift': 'text/x-swift',
  '.dart': 'text/x-dart',

  
  '.hs': 'text/x-haskell',
  '.ml': 'text/x-ocaml',
  '.ex': 'text/x-elixir',
  '.exs': 'text/x-elixir',
  '.erl': 'text/x-erlang',
  '.lua': 'text/x-lua',
  '.pl': 'text/x-perl',
  '.pm': 'text/x-perl',
  '.r': 'text/x-r',
  '.jl': 'text/x-julia',

  
  '.tf': 'text/x-terraform',
  '.hcl': 'text/x-hcl',
  '.nix': 'text/x-nix',
  '.cmake': 'text/x-cmake',
  '.gradle': 'text/x-groovy',
  '.dockerfile': 'text/x-dockerfile',

  
  '.proto': 'text/x-protobuf',
  '.graphql': 'text/x-graphql',
  '.gql': 'text/x-graphql',
  '.sol': 'text/x-solidity',
  '.svg': 'image/svg+xml',
};


export function getMimeType(ext) {
  const normalizedExt = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return MIME_TYPES[normalizedExt] || 'text/plain';
}

