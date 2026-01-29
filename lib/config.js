import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { ProjectDetector } from './project-detector.js';

const DEFAULT_CONFIG = {
  searchDirectory: '.',
  fileExtensions: [
    // JavaScript/TypeScript
    'js',
    'ts',
    'jsx',
    'tsx',
    'mjs',
    'cjs',
    'mts',
    'cts',
    // Styles
    'css',
    'scss',
    'sass',
    'less',
    'styl',
    'stylus',
    'postcss',
    // Web Frameworks
    'vue',
    'svelte',
    'astro',
    // Markup
    'html',
    'htm',
    'xml',
    'svg',
    'xhtml',
    'pug',
    'jade',
    // Templating
    'handlebars',
    'hbs',
    'mustache',
    'ejs',
    'njk',
    'liquid',
    // Python
    'py',
    'pyw',
    'pyx',
    'pxd',
    'pxi',
    'ipynb',
    // Java/JVM
    'java',
    'kt',
    'kts',
    'groovy',
    'gvy',
    'gradle',
    'scala',
    'sbt',
    'clj',
    'cljs',
    'cljc',
    'edn',
    // C/C++ family
    'c',
    'cpp',
    'cc',
    'cxx',
    'h',
    'hpp',
    'hxx',
    'h++',
    'm',
    'mm',
    // .NET
    'cs',
    'csx',
    'vb',
    'vbs',
    'fs',
    'fsx',
    'fsi',
    // System
    'go',
    'rs',
    'rlib',
    'swift',
    // Ruby
    'rb',
    'erb',
    'rake',
    'gemspec',
    // PHP
    'php',
    'phtml',
    'php3',
    'php4',
    'php5',
    'phps',
    // Neural/AI/Data
    'r',
    'rmd',
    'jl',
    // Shell/Config
    'sh',
    'bash',
    'zsh',
    'fish',
    'ksh',
    'csh',
    'tcsh',
    'bat',
    'cmd',
    'ps1',
    'psm1',
    'json',
    'json5',
    'jsonc',
    'yaml',
    'yml',
    'toml',
    'ini',
    'cfg',
    'conf',
    'properties',
    'env',
    'dockerfile',
    'containerfile',
    'makefile',
    'mk',
    'cmake',
    'jenkinsfile',
    'vagrantfile',
    // Database
    'sql',
    'pgsql',
    'mysql',
    'sqlite',
    // Docs
    'md',
    'markdown',
    'mdx',
    'txt',
    'rst',
    'adoc',
    'asciidoc',
    'tex',
    'latex',
    // Functional/Other
    'lua',
    'pl',
    'pm',
    't',
    'dart',
    'el',
    'lisp',
    'lsp',
    'scm',
    'ss',
    'erl',
    'hrl',
    'ex',
    'exs',
    'hs',
    'lhs',
    'ml',
    'mli',
    'v',
    'vh',
    'sv',
    'svh',
    'coffee',
    'litcoffee',
    // API/Structs
    'proto',
    'graphql',
    'gql',
    'sol',
    'vy',
    'tf',
    'tfvars',
    'hcl',
    'nix',
  ],
  fileNames: [
    'Dockerfile',
    'Containerfile',
    'Makefile',
    'Jenkinsfile',
    'Vagrantfile',
    'CMakeLists.txt',
    '.gitignore',
    '.env',
    'docker-compose.yml',
    'docker-compose.yaml',
  ],
  excludePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.git/**',
    '**/coverage/**',
    '**/.next/**',
    '**/target/**',
    '**/vendor/**',
    '**/.smart-coding-cache/**',
  ],
  chunkSize: 16, // Lines per chunk (tuned for speed/memory balance)
  chunkOverlap: 4, // Overlap between chunks for context continuity
  batchSize: 50, // Number of files to process in a single indexing batch
  maxFileSize: 1048576, // 1MB - skip files larger than this
  prefilterContentMaxBytes: 512 * 1024, // 512KB - cache content during prefilter to avoid double reads
  maxResults: 5, // Maximum number of semantic search results to return
  enableCache: true, // Whether to persist and reload embeddings between sessions
  autoCleanStaleCaches: true, // Automatically remove project caches not accessed for a long time
  cacheDirectory: null, // Will be set dynamically by loadConfig()
  watchFiles: true, // Enable file system watcher to re-index changed files in real-time
  verbose: false, // Enable detailed logging for debugging and progress tracking
  workerThreads: 'auto', // "auto" = CPU cores - 1, or set a number
  workerBatchTimeoutMs: 120000, // Timeout per worker batch before fallback (ms)
  workerFailureThreshold: 1, // Open circuit after N worker failures
  workerFailureCooldownMs: 10 * 60 * 1000, // Cooldown before retrying workers
  workerMaxChunksPerBatch: 100, // Cap chunks per worker batch to reduce hang risk
  allowSingleThreadFallback: false, // Allow fallback to main-thread embeddings if workers fail
  embeddingProcessPerBatch: true, // Use child process per batch for memory isolation
  embeddingModel: 'jinaai/jina-embeddings-v2-base-code', // AI model ID used for semantic search - can be changed with a lighter model for speed
  semanticWeight: 0.7, // Balance between semantic and keyword scores (0.0 to 1.0)
  exactMatchBoost: 1.5, // Multiplier applied when an exact string match is found
  recencyBoost: 0.1, // Boost for recently modified files (max 0.1 added to score)
  recencyDecayDays: 30, // After this many days, recency boost is 0
  smartIndexing: true, // Enable automatic project type detection and smart ignore patterns
  callGraphEnabled: true, // Enable call graph extraction for proximity boosting
  callGraphBoost: 0.15, // Boost for files related via call graph (0-1)
  callGraphMaxHops: 1, // How many levels of calls to follow (1 = direct only)
  annEnabled: true, // Enable Approximate Nearest Neighbor (ANN) index for large codebases
  annMinChunks: 5000, // Minimum number of chunks required to trigger ANN indexing
  annMinCandidates: 50, // Minimum initial candidates to pull from ANN before refinement
  annMaxCandidates: 200, // Hard limit on the number of ANN candidates to process
  annCandidateMultiplier: 20, // Scale initial search depth based on requested maxResults
  annEfConstruction: 200, // HNSW index construction quality (higher = better index, slower build)
  annEfSearch: 64, // HNSW search parameter (higher = more accurate, slower search)
  annM: 16, // Number of connections per element in HNSW index
  annIndexCache: true, // Whether to cache the built HNSW index on disk
  annMetric: 'cosine', // Distance metric for similarity (currently locked to cosine)
};

let config = { ...DEFAULT_CONFIG };

export async function loadConfig(workspaceDir = null) {
  try {
    // Determine the base directory for configuration
    let baseDir;
    let configPath;

    if (workspaceDir) {
      // Workspace mode: load config from workspace root
      baseDir = path.resolve(workspaceDir);
      configPath = path.join(baseDir, 'config.json');
      console.info(`[Config] Workspace mode: ${baseDir}`);
    } else {
      // Server mode: load config from server directory for global settings,
      // but use process.cwd() as base for searching if not specified otherwise
      const scriptDir = path.dirname(fileURLToPath(import.meta.url));
      const serverDir = path.resolve(scriptDir, '..');
      configPath = path.join(serverDir, 'config.json');
      baseDir = process.cwd();
    }

    let userConfig = {};
    try {
      const configData = await fs.readFile(configPath, 'utf-8');
      userConfig = JSON.parse(configData);
    } catch (_configError) {
      // If config not found in server dir, try CWD
      if (!workspaceDir) {
        try {
          const localConfigPath = path.join(baseDir, 'config.json');
          const configData = await fs.readFile(localConfigPath, 'utf-8');
          userConfig = JSON.parse(configData);
          configPath = localConfigPath;
        } catch {
          // ignore
        }
      }
    }

    config = { ...DEFAULT_CONFIG, ...userConfig };

    // Set search and cache directories
    config.searchDirectory = baseDir;

    // Determine cache directory
    if (userConfig.cacheDirectory) {
      // User explicitly set a cache path in their config.json
      config.cacheDirectory = path.isAbsolute(userConfig.cacheDirectory)
        ? userConfig.cacheDirectory
        : path.join(baseDir, userConfig.cacheDirectory);
    } else {
      // Use global cache directory to prevent cluttering project root
      // Hash the absolute path to ensure uniqueness per project
      const projectHash = crypto.createHash('md5').update(baseDir).digest('hex').slice(0, 12);
      const globalCacheRoot = getGlobalCacheDir();
      config.cacheDirectory = path.join(globalCacheRoot, 'heuristic-mcp', projectHash);

      // Support legacy .smart-coding-cache if it already exists in the project root
      const legacyPath = path.join(baseDir, '.smart-coding-cache');
      try {
        const stats = await fs.stat(legacyPath);
        if (stats.isDirectory()) {
          config.cacheDirectory = legacyPath;
          if (config.verbose) {
            console.error(`[Config] Using existing local cache: ${legacyPath}`);
          }
        }
      } catch {
        // Legacy folder doesn't exist, using global path
      }
    }

    // Smart project detection
    if (config.smartIndexing !== false) {
      const detector = new ProjectDetector(config.searchDirectory);
      const detectedTypes = await detector.detectProjectTypes();

      if (detectedTypes.length > 0) {
        const smartPatterns = detector.getSmartIgnorePatterns();

        // Merge smart patterns with user patterns (user patterns take precedence)
        const userPatterns = userConfig.excludePatterns || [];
        config.excludePatterns = [...smartPatterns, ...userPatterns];

        console.info(`[Config] Smart indexing: ${detectedTypes.join(', ')}`);
        console.info(`[Config] Applied ${smartPatterns.length} smart ignore patterns`);
      } else {
        console.info('[Config] No project markers detected, using default patterns');
      }
    }

    console.info('[Config] Loaded configuration from config.json');
  } catch (error) {
    console.warn('[Config] Using default configuration (config.json not found or invalid)');
    console.warn(`[Config] Error: ${error.message}`);
  }

  // Apply environment variable overrides (prefix: SMART_CODING_) with validation
  if (process.env.SMART_CODING_VERBOSE !== undefined) {
    const value = process.env.SMART_CODING_VERBOSE;
    if (value === 'true' || value === 'false') {
      config.verbose = value === 'true';
    }
  }

  if (process.env.SMART_CODING_BATCH_SIZE !== undefined) {
    const value = parseInt(process.env.SMART_CODING_BATCH_SIZE, 10);
    if (!isNaN(value) && value > 0 && value <= 1000) {
      config.batchSize = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_BATCH_SIZE: ${process.env.SMART_CODING_BATCH_SIZE}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_MAX_FILE_SIZE !== undefined) {
    const value = parseInt(process.env.SMART_CODING_MAX_FILE_SIZE, 10);
    if (!isNaN(value) && value > 0) {
      config.maxFileSize = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_MAX_FILE_SIZE: ${process.env.SMART_CODING_MAX_FILE_SIZE}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_CHUNK_SIZE !== undefined) {
    const value = parseInt(process.env.SMART_CODING_CHUNK_SIZE, 10);
    if (!isNaN(value) && value > 0 && value <= 100) {
      config.chunkSize = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_CHUNK_SIZE: ${process.env.SMART_CODING_CHUNK_SIZE}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_MAX_RESULTS !== undefined) {
    const value = parseInt(process.env.SMART_CODING_MAX_RESULTS, 10);
    if (!isNaN(value) && value > 0 && value <= 100) {
      config.maxResults = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_MAX_RESULTS: ${process.env.SMART_CODING_MAX_RESULTS}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_SMART_INDEXING !== undefined) {
    const value = process.env.SMART_CODING_SMART_INDEXING;
    if (value === 'true' || value === 'false') {
      config.smartIndexing = value === 'true';
    }
  }

  if (process.env.SMART_CODING_RECENCY_BOOST !== undefined) {
    const value = parseFloat(process.env.SMART_CODING_RECENCY_BOOST);
    if (!isNaN(value) && value >= 0 && value <= 1) {
      config.recencyBoost = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_RECENCY_BOOST: ${process.env.SMART_CODING_RECENCY_BOOST}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_RECENCY_DECAY_DAYS !== undefined) {
    const value = parseInt(process.env.SMART_CODING_RECENCY_DECAY_DAYS, 10);
    if (!isNaN(value) && value > 0 && value <= 365) {
      config.recencyDecayDays = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_RECENCY_DECAY_DAYS: ${process.env.SMART_CODING_RECENCY_DECAY_DAYS}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_WATCH_FILES !== undefined) {
    const value = process.env.SMART_CODING_WATCH_FILES;
    if (value === 'true' || value === 'false') {
      config.watchFiles = value === 'true';
    }
  }

  if (process.env.SMART_CODING_SEMANTIC_WEIGHT !== undefined) {
    const value = parseFloat(process.env.SMART_CODING_SEMANTIC_WEIGHT);
    if (!isNaN(value) && value >= 0 && value <= 1) {
      config.semanticWeight = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_SEMANTIC_WEIGHT: ${process.env.SMART_CODING_SEMANTIC_WEIGHT}, using default (must be 0-1)`
      );
    }
  }

  if (process.env.SMART_CODING_EXACT_MATCH_BOOST !== undefined) {
    const value = parseFloat(process.env.SMART_CODING_EXACT_MATCH_BOOST);
    if (!isNaN(value) && value >= 0) {
      config.exactMatchBoost = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_EXACT_MATCH_BOOST: ${process.env.SMART_CODING_EXACT_MATCH_BOOST}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_EMBEDDING_MODEL !== undefined) {
    const value = process.env.SMART_CODING_EMBEDDING_MODEL.trim();
    if (value.length > 0) {
      config.embeddingModel = value;
      console.info(`[Config] Using custom embedding model: ${value}`);
    }
  }

  if (process.env.SMART_CODING_WORKER_THREADS !== undefined) {
    const value = process.env.SMART_CODING_WORKER_THREADS.trim().toLowerCase();
    if (value === 'auto') {
      config.workerThreads = 'auto';
    } else {
      const numValue = parseInt(value, 10);
      if (!isNaN(numValue) && numValue >= 1 && numValue <= 32) {
        config.workerThreads = numValue;
      } else {
        console.warn(
          `[Config] Invalid SMART_CODING_WORKER_THREADS: ${value}, using default (must be 'auto' or 1-32)`
        );
      }
    }
  }

  if (process.env.SMART_CODING_ANN_ENABLED !== undefined) {
    const value = process.env.SMART_CODING_ANN_ENABLED;
    if (value === 'true' || value === 'false') {
      config.annEnabled = value === 'true';
    }
  }

  if (process.env.SMART_CODING_ANN_MIN_CHUNKS !== undefined) {
    const value = parseInt(process.env.SMART_CODING_ANN_MIN_CHUNKS, 10);
    if (!isNaN(value) && value >= 0) {
      config.annMinChunks = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_ANN_MIN_CHUNKS: ${process.env.SMART_CODING_ANN_MIN_CHUNKS}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_ANN_MIN_CANDIDATES !== undefined) {
    const value = parseInt(process.env.SMART_CODING_ANN_MIN_CANDIDATES, 10);
    if (!isNaN(value) && value >= 0) {
      config.annMinCandidates = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_ANN_MIN_CANDIDATES: ${process.env.SMART_CODING_ANN_MIN_CANDIDATES}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_ANN_MAX_CANDIDATES !== undefined) {
    const value = parseInt(process.env.SMART_CODING_ANN_MAX_CANDIDATES, 10);
    if (!isNaN(value) && value > 0) {
      config.annMaxCandidates = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_ANN_MAX_CANDIDATES: ${process.env.SMART_CODING_ANN_MAX_CANDIDATES}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_ANN_CANDIDATE_MULTIPLIER !== undefined) {
    const value = parseFloat(process.env.SMART_CODING_ANN_CANDIDATE_MULTIPLIER);
    if (!isNaN(value) && value > 0) {
      config.annCandidateMultiplier = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_ANN_CANDIDATE_MULTIPLIER: ${process.env.SMART_CODING_ANN_CANDIDATE_MULTIPLIER}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_ANN_EF_CONSTRUCTION !== undefined) {
    const value = parseInt(process.env.SMART_CODING_ANN_EF_CONSTRUCTION, 10);
    if (!isNaN(value) && value > 0) {
      config.annEfConstruction = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_ANN_EF_CONSTRUCTION: ${process.env.SMART_CODING_ANN_EF_CONSTRUCTION}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_ANN_EF_SEARCH !== undefined) {
    const value = parseInt(process.env.SMART_CODING_ANN_EF_SEARCH, 10);
    if (!isNaN(value) && value > 0) {
      config.annEfSearch = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_ANN_EF_SEARCH: ${process.env.SMART_CODING_ANN_EF_SEARCH}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_ANN_M !== undefined) {
    const value = parseInt(process.env.SMART_CODING_ANN_M, 10);
    if (!isNaN(value) && value > 0 && value <= 64) {
      config.annM = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_ANN_M: ${process.env.SMART_CODING_ANN_M}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_ANN_INDEX_CACHE !== undefined) {
    const value = process.env.SMART_CODING_ANN_INDEX_CACHE;
    if (value === 'true' || value === 'false') {
      config.annIndexCache = value === 'true';
    }
  }

  if (process.env.SMART_CODING_ANN_METRIC !== undefined) {
    const value = process.env.SMART_CODING_ANN_METRIC.trim().toLowerCase();
    if (value === 'cosine' || value === 'ip' || value === 'l2') {
      config.annMetric = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_ANN_METRIC: ${process.env.SMART_CODING_ANN_METRIC}, using default`
      );
    }
  }

  if (config.annMetric !== 'cosine') {
    console.warn(`[Config] ANN metric locked to cosine, overriding "${config.annMetric}"`);
    config.annMetric = 'cosine';
  }

  // Safety cap for auto workers
  if (config.workerThreads === 'auto') {
    // ignore
  }

  return config;
}

/**
 * Get platform-specific global cache directory
 */
export function getGlobalCacheDir() {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches');
  }
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
}

export function getConfig() {
  return config;
}

export { DEFAULT_CONFIG };
