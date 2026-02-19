import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { ProjectDetector } from './project-detector.js';
import { parseJsonc } from './settings-editor.js';
import {
  EMBEDDING_PROCESS_DEFAULT_GC_MAX_REQUESTS_WITHOUT_COLLECTION,
  EMBEDDING_PROCESS_DEFAULT_GC_MIN_INTERVAL_MS,
  EMBEDDING_PROCESS_DEFAULT_GC_RSS_THRESHOLD_MB,
} from './constants.js';
import { getWorkspaceEnvDiagnosticKeys, getWorkspaceEnvKeys } from './workspace-env.js';

const DEFAULT_MEMORY_CLEANUP_CONFIG = {
  enableExplicitGc: true, 
  clearCacheAfterIndex: true, 
  unloadModelAfterIndex: true, 
  shutdownQueryEmbeddingPoolAfterIndex: true, 
  unloadModelAfterSearch: true, 
  embeddingPoolIdleTimeoutMs: 2000, 
  incrementalGcThresholdMb: 512, 
  incrementalMemoryProfile: false, 
  recycleServerOnHighRssAfterIncremental: false, 
  recycleServerOnHighRssThresholdMb: 4096, 
  recycleServerOnHighRssCooldownMs: 300000, 
  recycleServerOnHighRssDelayMs: 2000, 
};

const DEFAULT_INDEXING_CONFIG = {
  smartIndexing: true, 
  chunkSize: 16, 
  chunkOverlap: 4, 
  batchSize: 50, 
  maxFileSize: 1048576, 
  prefilterContentMaxBytes: 512 * 1024, 
  maxResults: 5, 
  watchFiles: true, 
  indexCheckpointIntervalMs: 5000, 
};

const DEFAULT_LOGGING_CONFIG = {
  verbose: false, 
  memoryLogIntervalMs: 5000, 
};

const DEFAULT_CACHE_CONFIG = {
  enableCache: true, 
  saveReaderWaitTimeoutMs: 5000, 
  cacheVectorAssumeFinite: true, 
  cacheVectorFloatDigits: null, 
  cacheWriteHighWaterMark: 262144, 
  cacheVectorFlushChars: 262144, 
  cacheVectorCheckFinite: true, 
  cacheVectorNoMutation: false, 
  cacheVectorJoinThreshold: 8192, 
  cacheVectorJoinChunkSize: 2048, 
};

const DEFAULT_WORKER_CONFIG = {
  workerThreads: 'auto', 
  workerBatchTimeoutMs: 120000, 
  workerFailureThreshold: 1, 
  workerFailureCooldownMs: 10 * 60 * 1000, 
  workerMaxChunksPerBatch: 100, 
  allowSingleThreadFallback: false, 
  failFastEmbeddingErrors: false, 
};

const DEFAULT_EMBEDDING_CONFIG = {
  embeddingModel: 'jinaai/jina-embeddings-v2-base-code', 
  embeddingDimension: null, 
  preloadEmbeddingModel: true, 
  embeddingProcessPerBatch: false, 
  autoEmbeddingProcessPerBatch: true, 
  embeddingBatchSize: null, 
  embeddingProcessNumThreads: 8, 
  embeddingProcessGcRssThresholdMb: EMBEDDING_PROCESS_DEFAULT_GC_RSS_THRESHOLD_MB, 
  embeddingProcessGcMinIntervalMs: EMBEDDING_PROCESS_DEFAULT_GC_MIN_INTERVAL_MS, 
  embeddingProcessGcMaxRequestsWithoutCollection:
    EMBEDDING_PROCESS_DEFAULT_GC_MAX_REQUESTS_WITHOUT_COLLECTION, 
};

const DEFAULT_VECTOR_STORE_CONFIG = {
  vectorStoreFormat: 'binary', 
  vectorStoreContentMode: 'external', 
  contentCacheEntries: 256, 
  vectorStoreLoadMode: 'memory', 
  vectorCacheEntries: 0, 
};

const DEFAULT_SEARCH_CONFIG = {
  semanticWeight: 0.7, 
  exactMatchBoost: 1.5, 
  recencyBoost: 0.1, 
  recencyDecayDays: 30, 
  textMatchMaxCandidates: 2000, 
};

const DEFAULT_CALL_GRAPH_CONFIG = {
  callGraphEnabled: true, 
  callGraphBoost: 0.15, 
  callGraphMaxHops: 1, 
};

const DEFAULT_ANN_CONFIG = {
  annEnabled: true, 
  annMinChunks: 5000, 
  annMinCandidates: 50, 
  annMaxCandidates: 200, 
  annCandidateMultiplier: 20, 
  annEfConstruction: 200, 
  annEfSearch: 64, 
  annM: 16, 
  annIndexCache: true, 
  annMetric: 'cosine', 
};

const MEMORY_CLEANUP_KEYS = Object.freeze(Object.keys(DEFAULT_MEMORY_CLEANUP_CONFIG));
const INDEXING_KEYS = Object.freeze(Object.keys(DEFAULT_INDEXING_CONFIG));
const LOGGING_KEYS = Object.freeze(Object.keys(DEFAULT_LOGGING_CONFIG));
const CACHE_KEYS = Object.freeze(Object.keys(DEFAULT_CACHE_CONFIG));
const WORKER_KEYS = Object.freeze(Object.keys(DEFAULT_WORKER_CONFIG));
const EMBEDDING_KEYS = Object.freeze(Object.keys(DEFAULT_EMBEDDING_CONFIG));
const VECTOR_STORE_KEYS = Object.freeze(Object.keys(DEFAULT_VECTOR_STORE_CONFIG));
const SEARCH_KEYS = Object.freeze(Object.keys(DEFAULT_SEARCH_CONFIG));
const CALL_GRAPH_KEYS = Object.freeze(Object.keys(DEFAULT_CALL_GRAPH_CONFIG));
const ANN_KEYS = Object.freeze(Object.keys(DEFAULT_ANN_CONFIG));

const DEFAULT_CONFIG = {
  searchDirectory: '.',
  fileExtensions: [
    
    'js',
    'ts',
    'jsx',
    'tsx',
    'mjs',
    'cjs',
    'mts',
    'cts',
    
    'css',
    'scss',
    'sass',
    'less',
    'styl',
    'stylus',
    'postcss',
    
    'vue',
    'svelte',
    'astro',
    
    'html',
    'htm',
    'xml',
    'svg',
    'xhtml',
    'pug',
    'jade',
    
    'handlebars',
    'hbs',
    'mustache',
    'ejs',
    'njk',
    'liquid',
    
    'py',
    'pyw',
    'pyx',
    'pxd',
    'pxi',
    'ipynb',
    
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
    
    'cs',
    'csx',
    'vb',
    'vbs',
    'fs',
    'fsx',
    'fsi',
    
    'go',
    'rs',
    'rlib',
    'swift',
    
    'rb',
    'erb',
    'rake',
    'gemspec',
    
    'php',
    'phtml',
    'php3',
    'php4',
    'php5',
    'phps',
    
    'r',
    'rmd',
    'jl',
    
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
    
    'sql',
    'pgsql',
    'mysql',
    'sqlite',
    
    'md',
    'markdown',
    'mdx',
    'txt',
    'rst',
    'adoc',
    'asciidoc',
    'tex',
    'latex',
    
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
    '**/target/**',
    '**/vendor/**',
    '**/.next/**',
    '**/out/**',
    
    
    '**/.git/**',
    '**/.svn/**',
    '**/.hg/**',
    
    
    '**/coverage/**',
    '**/.vitest-coverage/**',
    '**/__tests__/**',
    '**/__mocks__/**',
    '**/test/**',
    '**/tests/**',
    
    
    '**/.agent/**',
    '**/.vscode/**',
    '**/.idea/**',
    
    
    '**/.smart-coding-cache/**',
    '**/.cache/**',
    '**/__pycache__/**',
    '**/tmp/**',
    '**/temp/**',
    
    
    '**/*.log',
    '**/.DS_Store',
    '**/Thumbs.db',
    
    
    '**/scripts/**',
    '**/tools/**',
  ],
  chunkSize: DEFAULT_INDEXING_CONFIG.chunkSize,
  chunkOverlap: DEFAULT_INDEXING_CONFIG.chunkOverlap,
  batchSize: DEFAULT_INDEXING_CONFIG.batchSize,
  maxFileSize: DEFAULT_INDEXING_CONFIG.maxFileSize,
  prefilterContentMaxBytes: DEFAULT_INDEXING_CONFIG.prefilterContentMaxBytes,
  maxResults: DEFAULT_INDEXING_CONFIG.maxResults,
  enableCache: DEFAULT_CACHE_CONFIG.enableCache,
  cacheDirectory: null, 
  
  cacheCleanup: {
    autoCleanup: true, 
    staleNoMetaHours: 6, 
    emptyThresholdHours: 24, 
    workspaceGraceDays: 7, 
    maxUnusedDays: 30, 
    tempThresholdHours: 24, 
    staleProgressHours: 6, 
    safetyWindowMinutes: 10, 
    removeDuplicates: true, 
  },
  watchFiles: DEFAULT_INDEXING_CONFIG.watchFiles,
  indexCheckpointIntervalMs: DEFAULT_INDEXING_CONFIG.indexCheckpointIntervalMs,
  verbose: DEFAULT_LOGGING_CONFIG.verbose,
  memoryLogIntervalMs: DEFAULT_LOGGING_CONFIG.memoryLogIntervalMs,
  saveReaderWaitTimeoutMs: DEFAULT_CACHE_CONFIG.saveReaderWaitTimeoutMs,
  workerThreads: DEFAULT_WORKER_CONFIG.workerThreads,
  workerBatchTimeoutMs: DEFAULT_WORKER_CONFIG.workerBatchTimeoutMs,
  workerFailureThreshold: DEFAULT_WORKER_CONFIG.workerFailureThreshold,
  workerFailureCooldownMs: DEFAULT_WORKER_CONFIG.workerFailureCooldownMs,
  workerMaxChunksPerBatch: DEFAULT_WORKER_CONFIG.workerMaxChunksPerBatch,
  allowSingleThreadFallback: DEFAULT_WORKER_CONFIG.allowSingleThreadFallback,
  failFastEmbeddingErrors: DEFAULT_WORKER_CONFIG.failFastEmbeddingErrors,
  embeddingProcessPerBatch: DEFAULT_EMBEDDING_CONFIG.embeddingProcessPerBatch,
  autoEmbeddingProcessPerBatch: DEFAULT_EMBEDDING_CONFIG.autoEmbeddingProcessPerBatch,
  embeddingBatchSize: DEFAULT_EMBEDDING_CONFIG.embeddingBatchSize,
  embeddingProcessNumThreads: DEFAULT_EMBEDDING_CONFIG.embeddingProcessNumThreads,
  embeddingProcessGcRssThresholdMb: DEFAULT_EMBEDDING_CONFIG.embeddingProcessGcRssThresholdMb,
  embeddingProcessGcMinIntervalMs: DEFAULT_EMBEDDING_CONFIG.embeddingProcessGcMinIntervalMs,
  embeddingProcessGcMaxRequestsWithoutCollection:
    DEFAULT_EMBEDDING_CONFIG.embeddingProcessGcMaxRequestsWithoutCollection,
  enableExplicitGc: DEFAULT_MEMORY_CLEANUP_CONFIG.enableExplicitGc,
  embeddingModel: DEFAULT_EMBEDDING_CONFIG.embeddingModel,
  embeddingDimension: DEFAULT_EMBEDDING_CONFIG.embeddingDimension,
  preloadEmbeddingModel: DEFAULT_EMBEDDING_CONFIG.preloadEmbeddingModel,
  vectorStoreFormat: DEFAULT_VECTOR_STORE_CONFIG.vectorStoreFormat,
  vectorStoreContentMode: DEFAULT_VECTOR_STORE_CONFIG.vectorStoreContentMode,
  contentCacheEntries: DEFAULT_VECTOR_STORE_CONFIG.contentCacheEntries,
  vectorStoreLoadMode: DEFAULT_VECTOR_STORE_CONFIG.vectorStoreLoadMode,
  vectorCacheEntries: DEFAULT_VECTOR_STORE_CONFIG.vectorCacheEntries,
  clearCacheAfterIndex: DEFAULT_MEMORY_CLEANUP_CONFIG.clearCacheAfterIndex,
  unloadModelAfterIndex: DEFAULT_MEMORY_CLEANUP_CONFIG.unloadModelAfterIndex,
  shutdownQueryEmbeddingPoolAfterIndex:
    DEFAULT_MEMORY_CLEANUP_CONFIG.shutdownQueryEmbeddingPoolAfterIndex,
  unloadModelAfterSearch: DEFAULT_MEMORY_CLEANUP_CONFIG.unloadModelAfterSearch,
  embeddingPoolIdleTimeoutMs: DEFAULT_MEMORY_CLEANUP_CONFIG.embeddingPoolIdleTimeoutMs,
  incrementalGcThresholdMb: DEFAULT_MEMORY_CLEANUP_CONFIG.incrementalGcThresholdMb,
  incrementalMemoryProfile: DEFAULT_MEMORY_CLEANUP_CONFIG.incrementalMemoryProfile,
  recycleServerOnHighRssAfterIncremental:
    DEFAULT_MEMORY_CLEANUP_CONFIG.recycleServerOnHighRssAfterIncremental,
  recycleServerOnHighRssThresholdMb:
    DEFAULT_MEMORY_CLEANUP_CONFIG.recycleServerOnHighRssThresholdMb,
  recycleServerOnHighRssCooldownMs:
    DEFAULT_MEMORY_CLEANUP_CONFIG.recycleServerOnHighRssCooldownMs,
  recycleServerOnHighRssDelayMs: DEFAULT_MEMORY_CLEANUP_CONFIG.recycleServerOnHighRssDelayMs,
  memoryCleanup: { ...DEFAULT_MEMORY_CLEANUP_CONFIG },
  semanticWeight: DEFAULT_SEARCH_CONFIG.semanticWeight,
  exactMatchBoost: DEFAULT_SEARCH_CONFIG.exactMatchBoost,
  recencyBoost: DEFAULT_SEARCH_CONFIG.recencyBoost,
  recencyDecayDays: DEFAULT_SEARCH_CONFIG.recencyDecayDays,
  textMatchMaxCandidates: DEFAULT_SEARCH_CONFIG.textMatchMaxCandidates,
  smartIndexing: DEFAULT_INDEXING_CONFIG.smartIndexing,
  callGraphEnabled: DEFAULT_CALL_GRAPH_CONFIG.callGraphEnabled,
  callGraphBoost: DEFAULT_CALL_GRAPH_CONFIG.callGraphBoost,
  callGraphMaxHops: DEFAULT_CALL_GRAPH_CONFIG.callGraphMaxHops,
  annEnabled: DEFAULT_ANN_CONFIG.annEnabled,
  annMinChunks: DEFAULT_ANN_CONFIG.annMinChunks,
  annMinCandidates: DEFAULT_ANN_CONFIG.annMinCandidates,
  annMaxCandidates: DEFAULT_ANN_CONFIG.annMaxCandidates,
  annCandidateMultiplier: DEFAULT_ANN_CONFIG.annCandidateMultiplier,
  annEfConstruction: DEFAULT_ANN_CONFIG.annEfConstruction,
  annEfSearch: DEFAULT_ANN_CONFIG.annEfSearch,
  annM: DEFAULT_ANN_CONFIG.annM,
  annIndexCache: DEFAULT_ANN_CONFIG.annIndexCache,
  annMetric: DEFAULT_ANN_CONFIG.annMetric,
  indexing: { ...DEFAULT_INDEXING_CONFIG },
  logging: { ...DEFAULT_LOGGING_CONFIG },
  cache: { ...DEFAULT_CACHE_CONFIG },
  worker: { ...DEFAULT_WORKER_CONFIG },
  embedding: { ...DEFAULT_EMBEDDING_CONFIG },
  vectorStore: { ...DEFAULT_VECTOR_STORE_CONFIG },
  search: { ...DEFAULT_SEARCH_CONFIG },
  callGraph: { ...DEFAULT_CALL_GRAPH_CONFIG },
  ann: { ...DEFAULT_ANN_CONFIG },
};

let config = { ...DEFAULT_CONFIG };

const WORKSPACE_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'requirements.txt',
  'Gemfile',
  'Makefile',
  'CMakeLists.txt',
];

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

const CONFIG_NAMESPACES = Object.freeze([
  {
    name: 'memoryCleanup',
    keys: MEMORY_CLEANUP_KEYS,
    defaults: DEFAULT_MEMORY_CLEANUP_CONFIG,
  },
  {
    name: 'indexing',
    keys: INDEXING_KEYS,
    defaults: DEFAULT_INDEXING_CONFIG,
  },
  {
    name: 'logging',
    keys: LOGGING_KEYS,
    defaults: DEFAULT_LOGGING_CONFIG,
  },
  {
    name: 'cache',
    keys: CACHE_KEYS,
    defaults: DEFAULT_CACHE_CONFIG,
  },
  {
    name: 'worker',
    keys: WORKER_KEYS,
    defaults: DEFAULT_WORKER_CONFIG,
  },
  {
    name: 'embedding',
    keys: EMBEDDING_KEYS,
    defaults: DEFAULT_EMBEDDING_CONFIG,
  },
  {
    name: 'vectorStore',
    keys: VECTOR_STORE_KEYS,
    defaults: DEFAULT_VECTOR_STORE_CONFIG,
  },
  {
    name: 'search',
    keys: SEARCH_KEYS,
    defaults: DEFAULT_SEARCH_CONFIG,
  },
  {
    name: 'callGraph',
    keys: CALL_GRAPH_KEYS,
    defaults: DEFAULT_CALL_GRAPH_CONFIG,
  },
  {
    name: 'ann',
    keys: ANN_KEYS,
    defaults: DEFAULT_ANN_CONFIG,
  },
]);

function applyNamespace(targetConfig, sourceConfig, namespaceName, keys, defaults) {
  const sourceNamespace =
    sourceConfig && typeof sourceConfig[namespaceName] === 'object'
      ? sourceConfig[namespaceName]
      : {};
  const mergedNamespace = {
    ...defaults,
    ...(targetConfig[namespaceName] && typeof targetConfig[namespaceName] === 'object'
      ? targetConfig[namespaceName]
      : {}),
  };

  for (const key of keys) {
    if (hasOwn(sourceNamespace, key)) {
      targetConfig[key] = mergedNamespace[key];
    } else {
      mergedNamespace[key] = targetConfig[key];
    }
  }

  targetConfig[namespaceName] = mergedNamespace;
}

function syncNamespace(targetConfig, namespaceName, keys, defaults) {
  const currentNamespace =
    targetConfig[namespaceName] && typeof targetConfig[namespaceName] === 'object'
      ? targetConfig[namespaceName]
      : {};
  const mergedNamespace = { ...defaults, ...currentNamespace };
  for (const key of keys) {
    mergedNamespace[key] = targetConfig[key];
  }
  targetConfig[namespaceName] = mergedNamespace;
}

function applyAllNamespaces(targetConfig, sourceConfig) {
  for (const namespace of CONFIG_NAMESPACES) {
    applyNamespace(
      targetConfig,
      sourceConfig,
      namespace.name,
      namespace.keys,
      namespace.defaults
    );
  }
}

function syncAllNamespaces(targetConfig) {
  for (const namespace of CONFIG_NAMESPACES) {
    syncNamespace(targetConfig, namespace.name, namespace.keys, namespace.defaults);
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readConfigFile(filePath) {
  try {
    const configData = await fs.readFile(filePath, 'utf-8');
    const parsed = parseJsonc(configData);
    return parsed || null;
  } catch {
    return null;
  }
}

async function findWorkspaceRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    for (const marker of WORKSPACE_MARKERS) {
      if (await pathExists(path.join(current, marker))) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir);
}

async function resolveWorkspaceCandidate(rawValue) {
  if (!rawValue || rawValue.includes('${')) return null;
  const candidate = path.resolve(rawValue);
  if (!(await pathExists(candidate))) return null;
  try {
    const stats = await fs.stat(candidate);
    if (!stats.isDirectory()) return null;
  } catch {
    return null;
  }
  return candidate;
}

function formatWorkspaceProbeValue(rawValue, maxLength = 120) {
  const value = String(rawValue || '').trim();
  if (!value) return '';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function logWorkspaceEnvProbe(entries) {
  if (!entries || entries.length === 0) {
    console.info('[Config] Workspace env probe: no workspace-like environment variables were set.');
    return;
  }

  const preview = entries.slice(0, 10).map((entry) => {
    const scope = entry.priority ? 'priority' : 'diagnostic';
    const status = entry.resolvedPath ? `valid:${entry.resolvedPath}` : `invalid:${entry.value}`;
    return `${entry.key}[${scope}]=${status}`;
  });
  const suffix = entries.length > 10 ? ` (+${entries.length - 10} more)` : '';
  console.info(`[Config] Workspace env probe: ${preview.join('; ')}${suffix}`);
}

function logWorkspaceResolution(resolution) {
  if (!resolution || !resolution.path) return;

  if (resolution.source === 'workspace-arg') {
    console.info(`[Config] Workspace resolution: --workspace -> ${resolution.path}`);
    return;
  }

  if (resolution.source === 'env' && resolution.envKey) {
    console.info(`[Config] Workspace resolution: env ${resolution.envKey} -> ${resolution.path}`);
    return;
  }

  if (resolution.source === 'test-cwd') {
    console.info(`[Config] Workspace resolution: process.cwd() (test mode) -> ${resolution.path}`);
    return;
  }

  if (resolution.source === 'cwd-root-search') {
    const from = resolution.fromPath || process.cwd();
    console.info(
      `[Config] Workspace resolution: workspace root from cwd (${from}) -> ${resolution.path}`
    );
    return;
  }

  console.info(`[Config] Workspace resolution: process.cwd() -> ${resolution.path}`);
}


export function isNonProjectDirectory(dir) {
  const normalized = dir.replace(/\\/g, '/').toLowerCase();
  const markers = [
    '/program files/',
    '/program files (x86)/',
    '/appdata/local/programs/',
    '/appdata/roaming/',
    '/applications/',
    '/contents/resources/',
  ];
  return markers.some((m) => normalized.includes(m));
}

async function resolveWorkspaceDir(workspaceDir) {
  if (workspaceDir) {
    return {
      path: path.resolve(workspaceDir),
      source: 'workspace-arg',
    };
  }
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
    return {
      path: path.resolve(process.cwd()),
      source: 'test-cwd',
    };
  }

  const prioritizedEnvKeys = getWorkspaceEnvKeys();
  const prioritizedEnvKeySet = new Set(prioritizedEnvKeys);
  const workspaceEnvProbe = [];

  for (const key of prioritizedEnvKeys) {
    const rawValue = process.env[key];
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
      continue;
    }
    const value = formatWorkspaceProbeValue(rawValue);
    const candidate = await resolveWorkspaceCandidate(rawValue);
    workspaceEnvProbe.push({
      key,
      value,
      resolvedPath: candidate,
      priority: true,
    });
    if (candidate) {
      return {
        path: candidate,
        source: 'env',
        envKey: key,
        workspaceEnvProbe,
      };
    }
  }

  for (const key of getWorkspaceEnvDiagnosticKeys()) {
    if (prioritizedEnvKeySet.has(key)) continue;
    const rawValue = process.env[key];
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
      continue;
    }
    const value = formatWorkspaceProbeValue(rawValue);
    const candidate = await resolveWorkspaceCandidate(rawValue);
    workspaceEnvProbe.push({
      key,
      value,
      resolvedPath: candidate,
      priority: false,
    });
  }

  logWorkspaceEnvProbe(workspaceEnvProbe);

  const cwd = path.resolve(process.cwd());

  
  if (isNonProjectDirectory(cwd)) {
    console.info(
      `[Config] CWD "${cwd}" appears to be an IDE/system directory. MCP roots detection will attempt auto-correction.`
    );
  }

  const root = await findWorkspaceRoot(cwd);
  if (root !== cwd) {
    return {
      path: root,
      source: 'cwd-root-search',
      fromPath: cwd,
      workspaceEnvProbe,
    };
  }
  return {
    path: cwd,
    source: 'cwd',
    workspaceEnvProbe,
  };
}

export async function loadConfig(workspaceDir = null) {
  let workspaceResolution = null;
  let baseDir = null;
  let searchDirectoryFromConfig = false;

  try {
    
    let configPath;

    let serverDir = null;
    if (workspaceDir) {
      
      workspaceResolution = await resolveWorkspaceDir(workspaceDir);
      baseDir = workspaceResolution.path;
      console.info(`[Config] Workspace mode: ${baseDir}`);
      logWorkspaceResolution(workspaceResolution);
    } else {
      // Server mode: load config from server directory for global settings,
      
      const scriptDir = path.dirname(fileURLToPath(import.meta.url));
      serverDir = path.resolve(scriptDir, '..');
      workspaceResolution = await resolveWorkspaceDir(null);
      baseDir = workspaceResolution.path;
      logWorkspaceResolution(workspaceResolution);
    }

    let userConfig = {};
    const configNames = ['config.jsonc', 'config.json'];

    if (workspaceDir) {
      for (const name of configNames) {
        const candidate = path.join(baseDir, name);
        const parsed = await readConfigFile(candidate);
        if (parsed) {
          userConfig = parsed;
          configPath = candidate;
          break;
        }
      }
    } else {
      for (const name of configNames) {
        const candidate = path.join(serverDir, name);
        const parsed = await readConfigFile(candidate);
        if (parsed) {
          userConfig = parsed;
          configPath = candidate;
          break;
        }
      }

      if (!configPath) {
        for (const name of configNames) {
          const candidate = path.join(baseDir, name);
          const parsed = await readConfigFile(candidate);
          if (parsed) {
            userConfig = parsed;
            configPath = candidate;
            break;
          }
        }
      }
    }

    config = { ...DEFAULT_CONFIG, ...userConfig };
    applyAllNamespaces(config, userConfig);

    
    if (
      hasOwn(userConfig, 'autoCleanStaleCaches') &&
      !(userConfig.cacheCleanup && hasOwn(userConfig.cacheCleanup, 'autoCleanup'))
    ) {
      config.cacheCleanup.autoCleanup = Boolean(userConfig.autoCleanStaleCaches);
    }

    
    if (userConfig.searchDirectory) {
      searchDirectoryFromConfig = true;
      config.searchDirectory = path.isAbsolute(userConfig.searchDirectory)
        ? userConfig.searchDirectory
        : path.join(baseDir, userConfig.searchDirectory);
    } else {
      config.searchDirectory = baseDir;
    }

    
    if (userConfig.cacheDirectory) {
      
      config.cacheDirectory = path.isAbsolute(userConfig.cacheDirectory)
        ? userConfig.cacheDirectory
        : path.join(baseDir, userConfig.cacheDirectory);
    } else {
      // Use global cache directory to prevent cluttering project root
      
      const projectHash = crypto
        .createHash('md5')
        .update(config.searchDirectory)
        .digest('hex')
        .slice(0, 12);
      const globalCacheRoot = getGlobalCacheDir();
      config.cacheDirectory = path.join(globalCacheRoot, 'heuristic-mcp', projectHash);

      
      const legacyPath = path.join(baseDir, '.smart-coding-cache');
      try {
        const stats = await fs.stat(legacyPath);
        if (stats.isDirectory()) {
          config.cacheDirectory = legacyPath;
          if (config.verbose) {
            console.info(`[Config] Using existing local cache: ${legacyPath}`);
          }
        }
      } catch {
        // Legacy folder doesn't exist, using global path
      }
    }

    
    if (config.smartIndexing !== false) {
      const detector = new ProjectDetector(config.searchDirectory);
      const detectedTypes = await detector.detectProjectTypes();

      if (detectedTypes.length > 0) {
        const smartPatterns = detector.getSmartIgnorePatterns();

        
        const userPatterns = userConfig.excludePatterns || [];
        config.excludePatterns = [...smartPatterns, ...userPatterns];

        console.info(`[Config] Smart indexing: ${detectedTypes.join(', ')}`);
        console.info(`[Config] Applied ${smartPatterns.length} smart ignore patterns`);
      } else {
        console.info('[Config] No project markers detected, using default patterns');
      }
    }

    if (configPath) {
      console.info(`[Config] Loaded configuration from ${path.basename(configPath)}`);
    } else {
      console.info('[Config] Loaded configuration from defaults');
    }
  } catch (error) {
    console.warn('[Config] Using default configuration (config.json/jsonc not found or invalid)');
    console.warn(`[Config] Error: ${error.message}`);
  }

  config.workspaceResolution = {
    source: workspaceResolution?.source || 'unknown',
    envKey: workspaceResolution?.envKey || null,
    fromPath: workspaceResolution?.fromPath || null,
    baseDirectory: baseDir,
    searchDirectory: config.searchDirectory,
    searchDirectoryFromConfig,
    workspaceEnvProbe: workspaceResolution?.workspaceEnvProbe || [],
  };

  
  if (process.env.SMART_CODING_VERBOSE !== undefined) {
    const value = process.env.SMART_CODING_VERBOSE;
    if (value === 'true' || value === 'false') {
      config.verbose = value === 'true';
    }
  }

  if (process.env.SMART_CODING_MEMORY_LOG_INTERVAL_MS !== undefined) {
    const value = parseInt(process.env.SMART_CODING_MEMORY_LOG_INTERVAL_MS, 10);
    if (!isNaN(value) && value >= 0 && value <= 300000) {
      config.memoryLogIntervalMs = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_MEMORY_LOG_INTERVAL_MS: ${process.env.SMART_CODING_MEMORY_LOG_INTERVAL_MS}, using default`
      );
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

  if (process.env.SMART_CODING_INDEX_CHECKPOINT_INTERVAL_MS !== undefined) {
    const value = parseInt(process.env.SMART_CODING_INDEX_CHECKPOINT_INTERVAL_MS, 10);
    if (!isNaN(value) && value >= 0) {
      config.indexCheckpointIntervalMs = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_INDEX_CHECKPOINT_INTERVAL_MS: ${process.env.SMART_CODING_INDEX_CHECKPOINT_INTERVAL_MS}, using default`
      );
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

  if (process.env.SMART_CODING_PRELOAD_EMBEDDING_MODEL !== undefined) {
    const value = process.env.SMART_CODING_PRELOAD_EMBEDDING_MODEL;
    if (value === 'true' || value === 'false') {
      config.preloadEmbeddingModel = value === 'true';
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_PRELOAD_EMBEDDING_MODEL: ${value}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_EXPLICIT_GC !== undefined) {
    const value = process.env.SMART_CODING_EXPLICIT_GC;
    if (value === 'true' || value === 'false') {
      config.enableExplicitGc = value === 'true';
    } else {
      console.warn(`[Config] Invalid SMART_CODING_EXPLICIT_GC: ${value}, using default`);
    }
  }

  if (process.env.SMART_CODING_VECTOR_STORE_FORMAT !== undefined) {
    const value = process.env.SMART_CODING_VECTOR_STORE_FORMAT.trim().toLowerCase();
    if (value === 'json' || value === 'binary' || value === 'sqlite') {
      config.vectorStoreFormat = value;
    } else {
      console.warn(`[Config] Invalid SMART_CODING_VECTOR_STORE_FORMAT: ${value}, using default`);
    }
  }

  if (process.env.SMART_CODING_VECTOR_STORE_CONTENT_MODE !== undefined) {
    const value = process.env.SMART_CODING_VECTOR_STORE_CONTENT_MODE.trim().toLowerCase();
    if (value === 'external' || value === 'inline') {
      config.vectorStoreContentMode = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_VECTOR_STORE_CONTENT_MODE: ${value}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_VECTOR_STORE_LOAD_MODE !== undefined) {
    const value = process.env.SMART_CODING_VECTOR_STORE_LOAD_MODE.trim().toLowerCase();
    if (value === 'memory' || value === 'disk') {
      config.vectorStoreLoadMode = value;
    } else {
      console.warn(`[Config] Invalid SMART_CODING_VECTOR_STORE_LOAD_MODE: ${value}, using default`);
    }
  }

  if (process.env.SMART_CODING_CLEAR_CACHE_AFTER_INDEX !== undefined) {
    const value = process.env.SMART_CODING_CLEAR_CACHE_AFTER_INDEX;
    if (value === 'true' || value === 'false') {
      config.clearCacheAfterIndex = value === 'true';
    }
  }

  if (process.env.SMART_CODING_UNLOAD_MODEL_AFTER_INDEX !== undefined) {
    const value = process.env.SMART_CODING_UNLOAD_MODEL_AFTER_INDEX;
    if (value === 'true' || value === 'false') {
      config.unloadModelAfterIndex = value === 'true';
    }
  }

  if (process.env.SMART_CODING_SHUTDOWN_QUERY_POOL_AFTER_INDEX !== undefined) {
    const value = process.env.SMART_CODING_SHUTDOWN_QUERY_POOL_AFTER_INDEX;
    if (value === 'true' || value === 'false') {
      config.shutdownQueryEmbeddingPoolAfterIndex = value === 'true';
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_SHUTDOWN_QUERY_POOL_AFTER_INDEX: ${value}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_UNLOAD_MODEL_AFTER_SEARCH !== undefined) {
    const value = process.env.SMART_CODING_UNLOAD_MODEL_AFTER_SEARCH;
    if (value === 'true' || value === 'false') {
      config.unloadModelAfterSearch = value === 'true';
    }
  }

  if (process.env.SMART_CODING_INCREMENTAL_GC_THRESHOLD_MB !== undefined) {
    const value = parseInt(process.env.SMART_CODING_INCREMENTAL_GC_THRESHOLD_MB, 10);
    if (!isNaN(value) && value >= 0) {
      config.incrementalGcThresholdMb = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_INCREMENTAL_GC_THRESHOLD_MB: ${process.env.SMART_CODING_INCREMENTAL_GC_THRESHOLD_MB}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_INCREMENTAL_MEMORY_PROFILE !== undefined) {
    const value = process.env.SMART_CODING_INCREMENTAL_MEMORY_PROFILE;
    if (value === 'true' || value === 'false') {
      config.incrementalMemoryProfile = value === 'true';
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_INCREMENTAL_MEMORY_PROFILE: ${value}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_RECYCLE_SERVER_ON_HIGH_RSS_AFTER_INCREMENTAL !== undefined) {
    const value = process.env.SMART_CODING_RECYCLE_SERVER_ON_HIGH_RSS_AFTER_INCREMENTAL;
    if (value === 'true' || value === 'false') {
      config.recycleServerOnHighRssAfterIncremental = value === 'true';
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_RECYCLE_SERVER_ON_HIGH_RSS_AFTER_INCREMENTAL: ${value}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_RECYCLE_SERVER_RSS_THRESHOLD_MB !== undefined) {
    const value = parseInt(process.env.SMART_CODING_RECYCLE_SERVER_RSS_THRESHOLD_MB, 10);
    if (!isNaN(value) && value > 0) {
      config.recycleServerOnHighRssThresholdMb = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_RECYCLE_SERVER_RSS_THRESHOLD_MB: ${process.env.SMART_CODING_RECYCLE_SERVER_RSS_THRESHOLD_MB}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_RECYCLE_SERVER_COOLDOWN_MS !== undefined) {
    const value = parseInt(process.env.SMART_CODING_RECYCLE_SERVER_COOLDOWN_MS, 10);
    if (!isNaN(value) && value >= 0) {
      config.recycleServerOnHighRssCooldownMs = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_RECYCLE_SERVER_COOLDOWN_MS: ${process.env.SMART_CODING_RECYCLE_SERVER_COOLDOWN_MS}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_RECYCLE_SERVER_DELAY_MS !== undefined) {
    const value = parseInt(process.env.SMART_CODING_RECYCLE_SERVER_DELAY_MS, 10);
    if (!isNaN(value) && value >= 0) {
      config.recycleServerOnHighRssDelayMs = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_RECYCLE_SERVER_DELAY_MS: ${process.env.SMART_CODING_RECYCLE_SERVER_DELAY_MS}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_CONTENT_CACHE_ENTRIES !== undefined) {
    const value = parseInt(process.env.SMART_CODING_CONTENT_CACHE_ENTRIES, 10);
    if (!isNaN(value) && value >= 0 && value <= 10000) {
      config.contentCacheEntries = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_CONTENT_CACHE_ENTRIES: ${process.env.SMART_CODING_CONTENT_CACHE_ENTRIES}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_VECTOR_CACHE_ENTRIES !== undefined) {
    const value = parseInt(process.env.SMART_CODING_VECTOR_CACHE_ENTRIES, 10);
    if (!isNaN(value) && value >= 0 && value <= 100000) {
      config.vectorCacheEntries = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_VECTOR_CACHE_ENTRIES: ${process.env.SMART_CODING_VECTOR_CACHE_ENTRIES}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_WORKER_THREADS !== undefined) {
    const value = process.env.SMART_CODING_WORKER_THREADS.trim().toLowerCase();
    if (value === 'auto') {
      config.workerThreads = 'auto';
    } else {
      const numValue = parseInt(value, 10);
      if (!isNaN(numValue) && numValue >= 0 && numValue <= 32) {
        config.workerThreads = numValue;
      } else {
        console.warn(
          `[Config] Invalid SMART_CODING_WORKER_THREADS: ${value}, using default (must be 'auto' or 1-32)`
        );
      }
    }
  }

  if (process.env.SMART_CODING_EMBEDDING_FAIL_FAST_BREAKER !== undefined) {
    const value = process.env.SMART_CODING_EMBEDDING_FAIL_FAST_BREAKER;
    if (value === 'true' || value === 'false') {
      config.failFastEmbeddingErrors = value === 'true';
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_EMBEDDING_FAIL_FAST_BREAKER: ${value}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_EMBEDDING_BATCH_SIZE !== undefined) {
    const value = parseInt(process.env.SMART_CODING_EMBEDDING_BATCH_SIZE, 10);
    if (!isNaN(value) && value > 0 && value <= 256) {
      config.embeddingBatchSize = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_EMBEDDING_BATCH_SIZE: ${process.env.SMART_CODING_EMBEDDING_BATCH_SIZE}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_EMBEDDING_THREADS !== undefined) {
    const value = parseInt(process.env.SMART_CODING_EMBEDDING_THREADS, 10);
    if (!isNaN(value) && value > 0 && value <= 32) {
      config.embeddingProcessNumThreads = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_EMBEDDING_THREADS: ${process.env.SMART_CODING_EMBEDDING_THREADS}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_EMBEDDING_PROCESS_GC_RSS_THRESHOLD_MB !== undefined) {
    const value = parseInt(process.env.SMART_CODING_EMBEDDING_PROCESS_GC_RSS_THRESHOLD_MB, 10);
    if (!isNaN(value) && value > 0) {
      config.embeddingProcessGcRssThresholdMb = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_EMBEDDING_PROCESS_GC_RSS_THRESHOLD_MB: ${process.env.SMART_CODING_EMBEDDING_PROCESS_GC_RSS_THRESHOLD_MB}, using default`
      );
    }
  }

  if (process.env.SMART_CODING_EMBEDDING_PROCESS_GC_MIN_INTERVAL_MS !== undefined) {
    const value = parseInt(process.env.SMART_CODING_EMBEDDING_PROCESS_GC_MIN_INTERVAL_MS, 10);
    if (!isNaN(value) && value >= 0) {
      config.embeddingProcessGcMinIntervalMs = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_EMBEDDING_PROCESS_GC_MIN_INTERVAL_MS: ${process.env.SMART_CODING_EMBEDDING_PROCESS_GC_MIN_INTERVAL_MS}, using default`
      );
    }
  }

  const embeddingProcessGcMaxRequestsEnv =
    process.env.SMART_CODING_EMBEDDING_PROCESS_GC_MAX_REQUESTS ??
    process.env.SMART_CODING_EMBEDDING_PROCESS_GC_MAX_REQUESTS_WITHOUT_COLLECTION;
  if (embeddingProcessGcMaxRequestsEnv !== undefined) {
    const value = parseInt(embeddingProcessGcMaxRequestsEnv, 10);
    if (!isNaN(value) && value > 0) {
      config.embeddingProcessGcMaxRequestsWithoutCollection = value;
    } else {
      console.warn(
        `[Config] Invalid SMART_CODING_EMBEDDING_PROCESS_GC_MAX_REQUESTS: ${embeddingProcessGcMaxRequestsEnv}, using default`
      );
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

  if (process.env.SMART_CODING_EMBEDDING_DIMENSION !== undefined) {
    const value = process.env.SMART_CODING_EMBEDDING_DIMENSION.trim().toLowerCase();
    if (value === 'null' || value === '') {
      config.embeddingDimension = null;
    } else {
      const numValue = parseInt(value, 10);
      const validDimensions = [64, 128, 256, 512, 768];
      if (validDimensions.includes(numValue)) {
        config.embeddingDimension = numValue;
        console.info(`[Config] Using MRL embedding dimension: ${numValue}`);
      } else {
        console.warn(
          `[Config] Invalid SMART_CODING_EMBEDDING_DIMENSION: ${value}, must be 64/128/256/512/768 or null`
        );
      }
    }
  }

  if (config.embeddingBatchSize !== null) {
    const value = parseInt(config.embeddingBatchSize, 10);
    if (!isNaN(value) && value > 0 && value <= 256) {
      config.embeddingBatchSize = value;
    } else {
      console.warn(`[Config] Invalid embeddingBatchSize: ${config.embeddingBatchSize}, using auto`);
      config.embeddingBatchSize = null;
    }
  }

  if (config.embeddingProcessNumThreads !== null) {
    const value = parseInt(config.embeddingProcessNumThreads, 10);
    if (!isNaN(value) && value > 0 && value <= 32) {
      config.embeddingProcessNumThreads = value;
    } else {
      console.warn(
        `[Config] Invalid embeddingProcessNumThreads: ${config.embeddingProcessNumThreads}, using default`
      );
      config.embeddingProcessNumThreads = DEFAULT_CONFIG.embeddingProcessNumThreads;
    }
  }

  if (config.memoryLogIntervalMs !== null && config.memoryLogIntervalMs !== undefined) {
    const value = parseInt(config.memoryLogIntervalMs, 10);
    if (!isNaN(value) && value >= 0 && value <= 300000) {
      config.memoryLogIntervalMs = value;
    } else {
      console.warn(
        `[Config] Invalid memoryLogIntervalMs: ${config.memoryLogIntervalMs}, using default`
      );
      config.memoryLogIntervalMs = DEFAULT_CONFIG.memoryLogIntervalMs;
    }
  }

  if (
    config.embeddingProcessGcRssThresholdMb !== null &&
    config.embeddingProcessGcRssThresholdMb !== undefined
  ) {
    const value = parseInt(config.embeddingProcessGcRssThresholdMb, 10);
    if (!isNaN(value) && value > 0) {
      config.embeddingProcessGcRssThresholdMb = value;
    } else {
      console.warn(
        `[Config] Invalid embeddingProcessGcRssThresholdMb: ${config.embeddingProcessGcRssThresholdMb}, using default`
      );
      config.embeddingProcessGcRssThresholdMb =
        DEFAULT_CONFIG.embeddingProcessGcRssThresholdMb;
    }
  }

  if (
    config.embeddingProcessGcMinIntervalMs !== null &&
    config.embeddingProcessGcMinIntervalMs !== undefined
  ) {
    const value = parseInt(config.embeddingProcessGcMinIntervalMs, 10);
    if (!isNaN(value) && value >= 0) {
      config.embeddingProcessGcMinIntervalMs = value;
    } else {
      console.warn(
        `[Config] Invalid embeddingProcessGcMinIntervalMs: ${config.embeddingProcessGcMinIntervalMs}, using default`
      );
      config.embeddingProcessGcMinIntervalMs =
        DEFAULT_CONFIG.embeddingProcessGcMinIntervalMs;
    }
  }

  if (
    config.embeddingProcessGcMaxRequestsWithoutCollection !== null &&
    config.embeddingProcessGcMaxRequestsWithoutCollection !== undefined
  ) {
    const value = parseInt(config.embeddingProcessGcMaxRequestsWithoutCollection, 10);
    if (!isNaN(value) && value > 0) {
      config.embeddingProcessGcMaxRequestsWithoutCollection = value;
    } else {
      console.warn(
        `[Config] Invalid embeddingProcessGcMaxRequestsWithoutCollection: ${config.embeddingProcessGcMaxRequestsWithoutCollection}, using default`
      );
      config.embeddingProcessGcMaxRequestsWithoutCollection =
        DEFAULT_CONFIG.embeddingProcessGcMaxRequestsWithoutCollection;
    }
  }

  syncAllNamespaces(config);
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
