import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { ProjectDetector } from "./project-detector.js";

const DEFAULT_CONFIG = {
  searchDirectory: ".",
  fileExtensions: [
    // JavaScript/TypeScript
    "js", "ts", "jsx", "tsx", "mjs", "cjs",
    // Styles
    "css", "scss", "sass", "less", "styl",
    // Markup
    "html", "htm", "xml", "svg",
    // Python
    "py", "pyw", "pyx",
    // Java/Kotlin/Scala
    "java", "kt", "kts", "scala",
    // C/C++
    "c", "cpp", "cc", "cxx", "h", "hpp", "hxx",
    // C#
    "cs", "csx",
    // Go
    "go",
    // Rust
    "rs",
    // Ruby
    "rb", "rake",
    // PHP
    "php", "phtml",
    // Swift
    "swift",
    // Shell scripts
    "sh", "bash", "zsh", "fish",
    // Config & Data
    "json", "yaml", "yml", "toml", "ini", "env",
    // Documentation
    "md", "mdx", "txt", "rst",
    // Database
    "sql",
    // Other
    "r", "R", "lua", "vim", "pl", "pm"
  ],
  excludePatterns: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/coverage/**",
    "**/.next/**",
    "**/target/**",
    "**/vendor/**",
    "**/.smart-coding-cache/**"
  ],
  chunkSize: 25, // Lines per chunk (larger = fewer embeddings = faster indexing)
  chunkOverlap: 5, // Overlap between chunks for context continuity
  batchSize: 100,
  maxFileSize: 1048576, // 1MB - skip files larger than this
  maxResults: 5,
  enableCache: true,
  cacheDirectory: "./.smart-coding-cache",
  watchFiles: true,
  verbose: false,
  workerThreads: "auto", // "auto" = CPU cores - 1, or set a number
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  semanticWeight: 0.7,
  exactMatchBoost: 1.5,
  recencyBoost: 0.1, // Boost for recently modified files (max 0.1 added to score)
  recencyDecayDays: 30, // After this many days, recency boost is 0
  smartIndexing: true,
  callGraphEnabled: true, // Enable call graph extraction for proximity boosting
  callGraphBoost: 0.15,   // Boost for files related via call graph (0-1)
  callGraphMaxHops: 1,    // How many levels of calls to follow (1 = direct only)
  annEnabled: true,
  annMinChunks: 5000,
  annMinCandidates: 50,
  annMaxCandidates: 200,
  annCandidateMultiplier: 20,
  annEfConstruction: 200,
  annEfSearch: 64,
  annM: 16,
  annIndexCache: true,
  annMetric: "cosine"
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
      configPath = path.join(baseDir, "config.json");
      console.error(`[Config] Workspace mode: ${baseDir}`);
    } else {
      // Server mode: load config from server directory for global settings,
      // but use process.cwd() as base for searching if not specified otherwise
      const scriptDir = path.dirname(fileURLToPath(import.meta.url));
      const serverDir = path.resolve(scriptDir, '..');
      configPath = path.join(serverDir, "config.json");
      baseDir = process.cwd();
    }

    let userConfig = {};
    try {
      const configData = await fs.readFile(configPath, "utf-8");
      userConfig = JSON.parse(configData);
    } catch (configError) {
      // If config not found in server dir, try CWD
      if (!workspaceDir) {
        try {
          const localConfigPath = path.join(baseDir, "config.json");
          const configData = await fs.readFile(localConfigPath, "utf-8");
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
    config.cacheDirectory = path.join(baseDir, ".smart-coding-cache");

    // Smart project detection
    if (config.smartIndexing !== false) {
      const detector = new ProjectDetector(config.searchDirectory);
      const detectedTypes = await detector.detectProjectTypes();

      if (detectedTypes.length > 0) {
        const smartPatterns = detector.getSmartIgnorePatterns();

        // Merge smart patterns with user patterns (user patterns take precedence)
        const userPatterns = userConfig.excludePatterns || [];
        config.excludePatterns = [
          ...smartPatterns,
          ...userPatterns
        ];

        console.error(`[Config] Smart indexing: ${detectedTypes.join(', ')}`);
        console.error(`[Config] Applied ${smartPatterns.length} smart ignore patterns`);
      } else {
        console.error("[Config] No project markers detected, using default patterns");
      }
    }

    console.error("[Config] Loaded configuration from config.json");
  } catch (error) {
    console.error("[Config] Using default configuration (config.json not found or invalid)");
    console.error(`[Config] Error: ${error.message}`);
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
      console.error(`[Config] Invalid SMART_CODING_BATCH_SIZE: ${process.env.SMART_CODING_BATCH_SIZE}, using default`);
    }
  }

  if (process.env.SMART_CODING_MAX_FILE_SIZE !== undefined) {
    const value = parseInt(process.env.SMART_CODING_MAX_FILE_SIZE, 10);
    if (!isNaN(value) && value > 0) {
      config.maxFileSize = value;
    } else {
      console.error(`[Config] Invalid SMART_CODING_MAX_FILE_SIZE: ${process.env.SMART_CODING_MAX_FILE_SIZE}, using default`);
    }
  }

  if (process.env.SMART_CODING_CHUNK_SIZE !== undefined) {
    const value = parseInt(process.env.SMART_CODING_CHUNK_SIZE, 10);
    if (!isNaN(value) && value > 0 && value <= 100) {
      config.chunkSize = value;
    } else {
      console.error(`[Config] Invalid SMART_CODING_CHUNK_SIZE: ${process.env.SMART_CODING_CHUNK_SIZE}, using default`);
    }
  }

  if (process.env.SMART_CODING_MAX_RESULTS !== undefined) {
    const value = parseInt(process.env.SMART_CODING_MAX_RESULTS, 10);
    if (!isNaN(value) && value > 0 && value <= 100) {
      config.maxResults = value;
    } else {
      console.error(`[Config] Invalid SMART_CODING_MAX_RESULTS: ${process.env.SMART_CODING_MAX_RESULTS}, using default`);
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
      console.error(`[Config] Invalid SMART_CODING_RECENCY_BOOST: ${process.env.SMART_CODING_RECENCY_BOOST}, using default`);
    }
  }

  if (process.env.SMART_CODING_RECENCY_DECAY_DAYS !== undefined) {
    const value = parseInt(process.env.SMART_CODING_RECENCY_DECAY_DAYS, 10);
    if (!isNaN(value) && value > 0 && value <= 365) {
      config.recencyDecayDays = value;
    } else {
      console.error(`[Config] Invalid SMART_CODING_RECENCY_DECAY_DAYS: ${process.env.SMART_CODING_RECENCY_DECAY_DAYS}, using default`);
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
      console.error(`[Config] Invalid SMART_CODING_SEMANTIC_WEIGHT: ${process.env.SMART_CODING_SEMANTIC_WEIGHT}, using default (must be 0-1)`);
    }
  }

  if (process.env.SMART_CODING_EXACT_MATCH_BOOST !== undefined) {
    const value = parseFloat(process.env.SMART_CODING_EXACT_MATCH_BOOST);
    if (!isNaN(value) && value >= 0) {
      config.exactMatchBoost = value;
    } else {
      console.error(`[Config] Invalid SMART_CODING_EXACT_MATCH_BOOST: ${process.env.SMART_CODING_EXACT_MATCH_BOOST}, using default`);
    }
  }

  if (process.env.SMART_CODING_EMBEDDING_MODEL !== undefined) {
    const value = process.env.SMART_CODING_EMBEDDING_MODEL.trim();
    if (value.length > 0) {
      config.embeddingModel = value;
      console.error(`[Config] Using custom embedding model: ${value}`);
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
        console.error(`[Config] Invalid SMART_CODING_WORKER_THREADS: ${value}, using default (must be 'auto' or 1-32)`);
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
      console.error(`[Config] Invalid SMART_CODING_ANN_MIN_CHUNKS: ${process.env.SMART_CODING_ANN_MIN_CHUNKS}, using default`);
    }
  }

  if (process.env.SMART_CODING_ANN_MIN_CANDIDATES !== undefined) {
    const value = parseInt(process.env.SMART_CODING_ANN_MIN_CANDIDATES, 10);
    if (!isNaN(value) && value >= 0) {
      config.annMinCandidates = value;
    } else {
      console.error(`[Config] Invalid SMART_CODING_ANN_MIN_CANDIDATES: ${process.env.SMART_CODING_ANN_MIN_CANDIDATES}, using default`);
    }
  }

  if (process.env.SMART_CODING_ANN_MAX_CANDIDATES !== undefined) {
    const value = parseInt(process.env.SMART_CODING_ANN_MAX_CANDIDATES, 10);
    if (!isNaN(value) && value > 0) {
      config.annMaxCandidates = value;
    } else {
      console.error(`[Config] Invalid SMART_CODING_ANN_MAX_CANDIDATES: ${process.env.SMART_CODING_ANN_MAX_CANDIDATES}, using default`);
    }
  }

  if (process.env.SMART_CODING_ANN_CANDIDATE_MULTIPLIER !== undefined) {
    const value = parseFloat(process.env.SMART_CODING_ANN_CANDIDATE_MULTIPLIER);
    if (!isNaN(value) && value > 0) {
      config.annCandidateMultiplier = value;
    } else {
      console.error(`[Config] Invalid SMART_CODING_ANN_CANDIDATE_MULTIPLIER: ${process.env.SMART_CODING_ANN_CANDIDATE_MULTIPLIER}, using default`);
    }
  }

  if (process.env.SMART_CODING_ANN_EF_CONSTRUCTION !== undefined) {
    const value = parseInt(process.env.SMART_CODING_ANN_EF_CONSTRUCTION, 10);
    if (!isNaN(value) && value > 0) {
      config.annEfConstruction = value;
    } else {
      console.error(`[Config] Invalid SMART_CODING_ANN_EF_CONSTRUCTION: ${process.env.SMART_CODING_ANN_EF_CONSTRUCTION}, using default`);
    }
  }

  if (process.env.SMART_CODING_ANN_EF_SEARCH !== undefined) {
    const value = parseInt(process.env.SMART_CODING_ANN_EF_SEARCH, 10);
    if (!isNaN(value) && value > 0) {
      config.annEfSearch = value;
    } else {
      console.error(`[Config] Invalid SMART_CODING_ANN_EF_SEARCH: ${process.env.SMART_CODING_ANN_EF_SEARCH}, using default`);
    }
  }

  if (process.env.SMART_CODING_ANN_M !== undefined) {
    const value = parseInt(process.env.SMART_CODING_ANN_M, 10);
    if (!isNaN(value) && value > 0 && value <= 64) {
      config.annM = value;
    } else {
      console.error(`[Config] Invalid SMART_CODING_ANN_M: ${process.env.SMART_CODING_ANN_M}, using default`);
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
    if (value === "cosine" || value === "ip" || value === "l2") {
      config.annMetric = value;
    } else {
      console.error(`[Config] Invalid SMART_CODING_ANN_METRIC: ${process.env.SMART_CODING_ANN_METRIC}, using default`);
    }
  }

  if (config.annMetric !== "cosine") {
    console.error(`[Config] ANN metric locked to cosine, overriding "${config.annMetric}"`);
    config.annMetric = "cosine";
  }

  // Safety cap for auto workers
  if (config.workerThreads === 'auto') {
    // Cap at 4 workers max by default to prevent OOM (each model ~150MB)
    // Users can override this by setting a specific number
    const cpuCount = process.env.UV_THREADPOOL_SIZE || 4; // Node doesn't expose os.cpus() in some envs
    // Actual logic happens in index-codebase.js, but we document the intent here
  }

  return config;
}

export function getConfig() {
  return config;
}

export { DEFAULT_CONFIG };
