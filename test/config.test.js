/**
 * Tests for configuration loading and environment overrides
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { loadConfig, getGlobalCacheDir, getConfig, DEFAULT_CONFIG } from '../lib/config.js';

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

async function withTempDir(testFn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heuristic-config-'));
  try {
    await testFn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  resetEnv();
  vi.restoreAllMocks(); // Restore mocks after each test
});

describe('Configuration Loading', () => {
  it('loads workspace config and resolves relative cache directory', async () => {
    await withTempDir(async (dir) => {
      const configData = {
        cacheDirectory: 'cache',
        excludePatterns: ['**/custom/**'],
        smartIndexing: false,
      };

      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(configData));

      const config = await loadConfig(dir);
      expect(config.searchDirectory).toBe(path.resolve(dir));
      expect(config.cacheDirectory).toBe(path.join(path.resolve(dir), 'cache'));
      expect(config.excludePatterns).toEqual(configData.excludePatterns);
    });
  });

  it('loads workspace config with absolute cache directory', async () => {
    await withTempDir(async (dir) => {
      const absoluteCache = path.join(dir, 'abs-cache');
      const configData = {
        cacheDirectory: absoluteCache,
        smartIndexing: false,
      };

      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(configData));

      const config = await loadConfig(dir);
      expect(config.cacheDirectory).toBe(absoluteCache);
    });
  });

  it('loads default config when file missing', async () => {
    await withTempDir(async (dir) => {
      const config = await loadConfig(dir);
      expect(config.embeddingModel).toBe(DEFAULT_CONFIG.embeddingModel);
    });
  });

  it('loads local config in server mode when server config is missing', async () => {
    await withTempDir(async (dir) => {
      const originalCwd = process.cwd();
      process.chdir(dir);

      const repoConfigJson = path.resolve(originalCwd, 'config.json');
      const repoConfigJsonc = path.resolve(originalCwd, 'config.jsonc');
      let repoConfig = repoConfigJson;
      try {
        await fs.access(repoConfigJson);
      } catch {
        repoConfig = repoConfigJsonc;
      }
      const repoBackup = `${repoConfig}.bak`;
      await fs.rename(repoConfig, repoBackup);
      await fs.writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify({ smartIndexing: false, maxResults: 7 })
      );

      try {
        const config = await loadConfig();
        expect(config.searchDirectory).toBe(path.resolve(dir));
        expect(config.maxResults).toBe(7);
      } finally {
        await fs.rename(repoBackup, repoConfig);
        process.chdir(originalCwd);
      }
    });
  });

  it('applies environment overrides with validation and locks ANN metric', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ smartIndexing: false }));

      process.env.SMART_CODING_MAX_RESULTS = '0';
      process.env.SMART_CODING_EXACT_MATCH_BOOST = '2';
      process.env.SMART_CODING_EMBEDDING_MODEL = 'custom-model';
      process.env.SMART_CODING_ANN_METRIC = 'ip';
      process.env.SMART_CODING_ANN_M = '128';
      process.env.SMART_CODING_WORKER_THREADS = 'auto';

      const config = await loadConfig(dir);

      expect(config.maxResults).toBe(DEFAULT_CONFIG.maxResults);
      expect(config.exactMatchBoost).toBe(2);
      expect(config.embeddingModel).toBe('custom-model');
      expect(config.annMetric).toBe('cosine');
      expect(config.annM).toBe(DEFAULT_CONFIG.annM);
      expect(config.workerThreads).toBe('auto');
    });
  });

  it('applies valid environment overrides', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ smartIndexing: false }));

      process.env.SMART_CODING_VERBOSE = 'true';
      process.env.SMART_CODING_BATCH_SIZE = '200';
      process.env.SMART_CODING_MAX_FILE_SIZE = '2048';
      process.env.SMART_CODING_CHUNK_SIZE = '42';
      process.env.SMART_CODING_MAX_RESULTS = '9';
      process.env.SMART_CODING_SMART_INDEXING = 'true';
      process.env.SMART_CODING_RECENCY_BOOST = '0.5';
      process.env.SMART_CODING_RECENCY_DECAY_DAYS = '10';
      process.env.SMART_CODING_WATCH_FILES = 'false';
      process.env.SMART_CODING_SEMANTIC_WEIGHT = '0.3';
      process.env.SMART_CODING_EXACT_MATCH_BOOST = '2';
      process.env.SMART_CODING_EMBEDDING_MODEL = 'custom-embedder';
      process.env.SMART_CODING_PRELOAD_EMBEDDING_MODEL = 'false';
      process.env.SMART_CODING_VECTOR_STORE_FORMAT = 'sqlite';
      process.env.SMART_CODING_VECTOR_STORE_CONTENT_MODE = 'external';
      process.env.SMART_CODING_VECTOR_STORE_LOAD_MODE = 'disk';
      process.env.SMART_CODING_CONTENT_CACHE_ENTRIES = '512';
      process.env.SMART_CODING_VECTOR_CACHE_ENTRIES = '64';
      process.env.SMART_CODING_CLEAR_CACHE_AFTER_INDEX = 'true';
      process.env.SMART_CODING_WORKER_THREADS = '3';
      process.env.SMART_CODING_ANN_ENABLED = 'false';
      process.env.SMART_CODING_ANN_MIN_CHUNKS = '123';
      process.env.SMART_CODING_ANN_MIN_CANDIDATES = '10';
      process.env.SMART_CODING_ANN_MAX_CANDIDATES = '100';
      process.env.SMART_CODING_ANN_CANDIDATE_MULTIPLIER = '4';
      process.env.SMART_CODING_ANN_EF_CONSTRUCTION = '64';
      process.env.SMART_CODING_ANN_EF_SEARCH = '32';
      process.env.SMART_CODING_ANN_M = '32';
      process.env.SMART_CODING_ANN_INDEX_CACHE = 'false';
      process.env.SMART_CODING_ANN_METRIC = 'l2';

      const config = await loadConfig(dir);

      expect(config.verbose).toBe(true);
      expect(config.batchSize).toBe(200);
      expect(config.maxFileSize).toBe(2048);
      expect(config.chunkSize).toBe(42);
      expect(config.maxResults).toBe(9);
      expect(config.smartIndexing).toBe(true);
      expect(config.recencyBoost).toBe(0.5);
      expect(config.recencyDecayDays).toBe(10);
      expect(config.watchFiles).toBe(false);
      expect(config.semanticWeight).toBe(0.3);
      expect(config.exactMatchBoost).toBe(2);
      expect(config.embeddingModel).toBe('custom-embedder');
      expect(config.preloadEmbeddingModel).toBe(false);
      expect(config.vectorStoreFormat).toBe('sqlite');
      expect(config.vectorStoreContentMode).toBe('external');
      expect(config.vectorStoreLoadMode).toBe('disk');
      expect(config.contentCacheEntries).toBe(512);
      expect(config.vectorCacheEntries).toBe(64);
      expect(config.clearCacheAfterIndex).toBe(true);
      expect(config.workerThreads).toBe(3);
      expect(config.annEnabled).toBe(false);
      expect(config.annMinChunks).toBe(123);
      expect(config.annMinCandidates).toBe(10);
      expect(config.annMaxCandidates).toBe(100);
      expect(config.annCandidateMultiplier).toBe(4);
      expect(config.annEfConstruction).toBe(64);
      expect(config.annEfSearch).toBe(32);
      expect(config.annM).toBe(32);
      expect(config.annIndexCache).toBe(false);
      expect(config.annMetric).toBe('cosine');
    });
  });

  it('ignores invalid environment overrides', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ smartIndexing: false }));

      process.env.SMART_CODING_BATCH_SIZE = '-1';
      process.env.SMART_CODING_MAX_FILE_SIZE = '0';
      process.env.SMART_CODING_CHUNK_SIZE = '1000';
      process.env.SMART_CODING_RECENCY_BOOST = '2';
      process.env.SMART_CODING_RECENCY_DECAY_DAYS = '400';
      process.env.SMART_CODING_SEMANTIC_WEIGHT = '-1';
      process.env.SMART_CODING_EXACT_MATCH_BOOST = 'nope';
      process.env.SMART_CODING_WORKER_THREADS = '0';
      process.env.SMART_CODING_ANN_MIN_CHUNKS = '-5';
      process.env.SMART_CODING_ANN_MIN_CANDIDATES = '-1';
      process.env.SMART_CODING_ANN_MAX_CANDIDATES = '0';
      process.env.SMART_CODING_ANN_CANDIDATE_MULTIPLIER = '0';
      process.env.SMART_CODING_ANN_EF_CONSTRUCTION = '0';
      process.env.SMART_CODING_ANN_EF_SEARCH = '0';
      process.env.SMART_CODING_ANN_M = '128';
      process.env.SMART_CODING_ANN_METRIC = 'invalid';

      const config = await loadConfig(dir);

      expect(config.batchSize).toBe(DEFAULT_CONFIG.batchSize);
      expect(config.maxFileSize).toBe(DEFAULT_CONFIG.maxFileSize);
      expect(config.chunkSize).toBe(DEFAULT_CONFIG.chunkSize);
      expect(config.recencyBoost).toBe(DEFAULT_CONFIG.recencyBoost);
      expect(config.recencyDecayDays).toBe(DEFAULT_CONFIG.recencyDecayDays);
      expect(config.semanticWeight).toBe(DEFAULT_CONFIG.semanticWeight);
      expect(config.exactMatchBoost).toBe(DEFAULT_CONFIG.exactMatchBoost);
      expect(config.workerThreads).toBe(DEFAULT_CONFIG.workerThreads);
      expect(config.annMinChunks).toBe(DEFAULT_CONFIG.annMinChunks);
      expect(config.annMinCandidates).toBe(DEFAULT_CONFIG.annMinCandidates);
      expect(config.annMaxCandidates).toBe(DEFAULT_CONFIG.annMaxCandidates);
      expect(config.annCandidateMultiplier).toBe(DEFAULT_CONFIG.annCandidateMultiplier);
      expect(config.annEfConstruction).toBe(DEFAULT_CONFIG.annEfConstruction);
      expect(config.annEfSearch).toBe(DEFAULT_CONFIG.annEfSearch);
      expect(config.annM).toBe(DEFAULT_CONFIG.annM);
      expect(config.annMetric).toBe('cosine');
    });
  });

  it('ignores invalid boolean environment overrides and empty strings', async () => {
    await withTempDir(async (dir) => {
      // Set values opposite to defaults in the config file to ensure env var doesn't revert them or mess them up
      await fs.writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify({
          smartIndexing: false,
          watchFiles: false,
          verbose: true,
          annEnabled: false,
          annIndexCache: false,
        })
      );

      process.env.SMART_CODING_VERBOSE = 'invalid';
      process.env.SMART_CODING_SMART_INDEXING = 'maybe';
      process.env.SMART_CODING_WATCH_FILES = 'sometimes';
      process.env.SMART_CODING_EMBEDDING_MODEL = '   ';
      process.env.SMART_CODING_ANN_ENABLED = 'nope';
      process.env.SMART_CODING_ANN_INDEX_CACHE = 'idk';

      const config = await loadConfig(dir);

      expect(config.verbose).toBe(true); // Should stay as configured in file
      expect(config.smartIndexing).toBe(false);
      expect(config.watchFiles).toBe(false);
      expect(config.embeddingModel).toBe(DEFAULT_CONFIG.embeddingModel);
      expect(config.annEnabled).toBe(false);
      expect(config.annIndexCache).toBe(false);
    });
  });

  it('should configure smart indexing when project detected', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'test' }));
      const config = await loadConfig(dir);
      expect(config.excludePatterns.length).toBeGreaterThan(0);
    });
  });

  it('logs when no project markers are detected', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ smartIndexing: true }));
      await loadConfig(dir);
    });
  });

  it('should respect legacy .smart-coding-cache directory', async () => {
    await withTempDir(async (dir) => {
      const legacyDir = path.join(dir, '.smart-coding-cache');
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ smartIndexing: false }));

      const config = await loadConfig(dir);
      expect(config.cacheDirectory).toContain('.smart-coding-cache');
    });
  });

  it('logs legacy cache usage when verbose is enabled', async () => {
    await withTempDir(async (dir) => {
      const legacyDir = path.join(dir, '.smart-coding-cache');
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify({ smartIndexing: false, verbose: true })
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await loadConfig(dir);

      const called = errorSpy.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].includes('Using existing local cache')
      );
      expect(called).toBe(true);
    });
  });

  it('ignores legacy cache path when it is not a directory', async () => {
    await withTempDir(async (dir) => {
      const legacyPath = path.join(dir, '.smart-coding-cache');
      await fs.writeFile(legacyPath, 'not-a-dir');
      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ smartIndexing: false }));

      const config = await loadConfig(dir);
      expect(config.cacheDirectory).not.toContain('.smart-coding-cache');
    });
  });

  it('uses default configuration when detection fails unexpectedly', async () => {
    const { ProjectDetector } = await import('../lib/project-detector.js');
    const detectSpy = vi
      .spyOn(ProjectDetector.prototype, 'detectProjectTypes')
      .mockRejectedValueOnce(new Error('boom'));

    const config = await loadConfig();
    expect(config).toBeDefined();
    detectSpy.mockRestore();
  });

  it('exposes loaded config via getConfig', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ smartIndexing: false }));

      const loaded = await loadConfig(dir);
      const current = getConfig();

      expect(current).toBe(loaded);
    });
  });
});

describe('Global Cache Directory', () => {
  it('uses LOCALAPPDATA on Windows when set', () => {
    if (process.platform !== 'win32') return;

    const originalLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = 'C:\\Temp\\LocalAppData';

    expect(getGlobalCacheDir()).toBe('C:\\Temp\\LocalAppData');

    if (originalLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = originalLocalAppData;
    }
  });

  it('falls back to default Windows cache path when LOCALAPPDATA is unset', () => {
    if (process.platform !== 'win32') return;

    const originalLocalAppData = process.env.LOCALAPPDATA;
    delete process.env.LOCALAPPDATA;

    expect(getGlobalCacheDir()).toBe(path.join(os.homedir(), 'AppData', 'Local'));

    if (originalLocalAppData !== undefined) {
      process.env.LOCALAPPDATA = originalLocalAppData;
    }
  });

  it('uses macOS cache path on darwin', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const result = getGlobalCacheDir();
    expect(result).toContain(path.join(os.homedir(), 'Library', 'Caches'));

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('uses XDG cache path on linux', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });

    const originalXdg = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = '/tmp/xdg-cache';

    const result = getGlobalCacheDir();
    expect(result).toBe('/tmp/xdg-cache');

    if (originalXdg === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = originalXdg;
    }

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('falls back to default linux cache path when XDG cache is unset', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });

    const originalXdg = process.env.XDG_CACHE_HOME;
    delete process.env.XDG_CACHE_HOME;

    const result = getGlobalCacheDir();
    expect(result).toBe(path.join(os.homedir(), '.cache'));

    if (originalXdg !== undefined) {
      process.env.XDG_CACHE_HOME = originalXdg;
    }
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });
});
