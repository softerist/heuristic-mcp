#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { stop, start, status, logs } from './features/lifecycle.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
let transformersModule = null;
async function getTransformers() {
  if (!transformersModule) {
    transformersModule = await import('@huggingface/transformers');
    if (transformersModule?.env) {
      transformersModule.env.cacheDir = path.join(getGlobalCacheDir(), 'xenova');
    }
  }
  return transformersModule;
}
import { configureNativeOnnxBackend, getNativeOnnxStatus } from './lib/onnx-backend.js';

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { getWorkspaceCachePathCandidates } from './lib/workspace-cache-key.js';

const require = createRequire(import.meta.url);
const packageJson = require('./package.json');

import { loadConfig, getGlobalCacheDir, isNonProjectDirectory } from './lib/config.js';
import { clearStaleCaches } from './lib/cache-utils.js';
import {
  enableStderrOnlyLogging,
  setupFileLogging,
  getLogFilePath,
  flushLogs,
} from './lib/logging.js';
import { parseArgs, printHelp } from './lib/cli.js';
import { clearCache } from './lib/cache-ops.js';
import { logMemory, startMemoryLogger } from './lib/memory-logger.js';
import {
  registerSignalHandlers,
  setupPidFile,
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  stopOtherHeuristicServers,
} from './lib/server-lifecycle.js';

import { EmbeddingsCache } from './lib/cache.js';
import {
  cleanupStaleBinaryArtifacts,
  recordBinaryStoreCorruption,
} from './lib/vector-store-binary.js';
import { CodebaseIndexer } from './features/index-codebase.js';
import { HybridSearch } from './features/hybrid-search.js';

import * as IndexCodebaseFeature from './features/index-codebase.js';
import * as HybridSearchFeature from './features/hybrid-search.js';
import * as ClearCacheFeature from './features/clear-cache.js';
import * as FindSimilarCodeFeature from './features/find-similar-code.js';
import * as AnnConfigFeature from './features/ann-config.js';
import * as PackageVersionFeature from './features/package-version.js';
import * as SetWorkspaceFeature from './features/set-workspace.js';
import { handleListResources, handleReadResource } from './features/resources.js';
import { getWorkspaceEnvKeys } from './lib/workspace-env.js';

import {
  MEMORY_LOG_INTERVAL_MS,
  ONNX_THREAD_LIMIT,
  BACKGROUND_INDEX_DELAY_MS,
  SERVER_KEEP_ALIVE_INTERVAL_MS,
} from './lib/constants.js';
const PID_FILE_NAME = '.heuristic-mcp.pid';

function isTestRuntime() {
  return (
    process.env.VITEST === 'true' ||
    process.env.NODE_ENV === 'test'
  );
}

async function readLogTail(logPath, maxLines = 2000) {
  const data = await fs.readFile(logPath, 'utf-8');
  if (!data) return [];
  const lines = data.split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines);
}

async function printMemorySnapshot(workspaceDir) {
  const activeConfig = await loadConfig(workspaceDir);
  const logPath = getLogFilePath(activeConfig);

  let lines;
  try {
    lines = await readLogTail(logPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`[Memory] No log file found for workspace.`);
      console.error(`[Memory] Expected location: ${logPath}`);
      console.error(
        '[Memory] Start the server with verbose logging (set "verbose": true), then try again.'
      );
      return false;
    }
    console.error(`[Memory] Failed to read log file: ${err.message}`);
    return false;
  }

  const memoryLines = lines.filter((line) => /Memory\s*\(/.test(line) || /Memory.*rss=/.test(line));
  if (memoryLines.length === 0) {
    console.info('[Memory] No memory snapshots found in logs.');
    console.info('[Memory] Ensure "verbose": true in config and restart the server.');
    return true;
  }

  const idleLine =
    [...memoryLines].reverse().find((line) => line.includes('after cache load')) ??
    memoryLines[memoryLines.length - 1];

  const logLine = (line) => {
    console.info(line);
    if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
      console.error(line);
    }
  };

  logLine(`[Memory] Idle snapshot: ${idleLine}`);

  const latestLine = memoryLines[memoryLines.length - 1];
  if (latestLine !== idleLine) {
    logLine(`[Memory] Latest snapshot: ${latestLine}`);
  }

  return true;
}

async function flushLogsSafely(options) {
  if (typeof flushLogs !== 'function') {
    console.warn('[Logs] flushLogs helper is unavailable; skipping log flush.');
    return;
  }

  try {
    await flushLogs(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Logs] Failed to flush logs: ${message}`);
  }
}

function assertCacheContract(cacheInstance) {
  const requiredMethods = [
    'load',
    'save',
    'consumeAutoReindex',
    'clearInMemoryState',
    'getStoreSize',
  ];
  const missing = requiredMethods.filter((name) => typeof cacheInstance?.[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `[Server] Cache implementation contract violation: missing method(s): ${missing.join(', ')}`
    );
  }
}

let embedder = null;
let unloadMainEmbedder = null;
let cache = null;
let indexer = null;
let hybridSearch = null;
let config = null;
let workspaceLockAcquired = true;
let configReadyResolve = null;
let configInitError = null;
let configReadyPromise = new Promise((resolve) => {
  configReadyResolve = resolve;
});
let setWorkspaceFeatureInstance = null;
let autoWorkspaceSwitchPromise = null;
let rootsCapabilitySupported = null;
let rootsProbeInFlight = null;
let lastRootsProbeTime = 0;
let keepAliveTimer = null;
let stdioShutdownHandlers = null;
const ROOTS_PROBE_COOLDOWN_MS = 2000;
const WORKSPACE_BOUND_TOOL_NAMES = new Set([
  'a_semantic_search',
  'b_index_codebase',
  'c_clear_cache',
  'd_find_similar_code',
  'd_ann_config',
]);
const trustedWorkspacePaths = new Set();

function shouldRequireTrustedWorkspaceSignalForTool(toolName) {
  return WORKSPACE_BOUND_TOOL_NAMES.has(toolName);
}

function trustWorkspacePath(workspacePath) {
  const normalized = normalizePathForCompare(workspacePath);
  if (normalized) {
    trustedWorkspacePaths.add(normalized);
  }
}

function isCurrentWorkspaceTrusted() {
  if (!config?.searchDirectory) return false;
  return trustedWorkspacePaths.has(normalizePathForCompare(config.searchDirectory));
}

function isToolResponseError(result) {
  if (!result || typeof result !== 'object') return true;
  if (result.isError === true) return true;
  if (!Array.isArray(result.content)) return false;

  return result.content.some(
    (entry) =>
      entry?.type === 'text' &&
      typeof entry.text === 'string' &&
      entry.text.trim().toLowerCase().startsWith('error:')
  );
}

function formatCrashDetail(detail) {
  if (detail instanceof Error) {
    return detail.stack || detail.message || String(detail);
  }
  if (typeof detail === 'string') {
    return detail;
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function isBrokenPipeError(detail) {
  if (!detail) return false;
  if (typeof detail === 'string') {
    return /(?:^|[\s:])EPIPE(?:[\s:]|$)|broken pipe/i.test(detail);
  }
  if (typeof detail === 'object') {
    if (detail.code === 'EPIPE') return true;
    if (typeof detail.message === 'string') {
      return /(?:^|[\s:])EPIPE(?:[\s:]|$)|broken pipe/i.test(detail.message);
    }
  }
  return false;
}

function isCrashShutdownReason(reason) {
  const normalized = String(reason || '').toLowerCase();
  return normalized.includes('uncaughtexception') || normalized.includes('unhandledrejection');
}

function shouldLogProcessLifecycle() {
  const value = String(process.env.HEURISTIC_MCP_PROCESS_LIFECYCLE || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function getShutdownExitCode(reason) {
  const normalized = String(reason || '').trim().toUpperCase();
  if (normalized === 'SIGINT') return 130;
  if (normalized === 'SIGTERM') return 143;
  return isCrashShutdownReason(reason) ? 1 : 0;
}

function registerProcessDiagnostics({ isServerMode, requestShutdown, getShutdownReason }) {
  if (!isServerMode) return;

  if (shouldLogProcessLifecycle()) {
    let beforeExitLogged = false;
    process.on('beforeExit', (code) => {
      if (beforeExitLogged) return;
      beforeExitLogged = true;
      const reason = getShutdownReason() || 'natural';
      console.info(`[Server] Process beforeExit (code=${code}, reason=${reason}).`);
    });

    process.on('exit', (code) => {
      const reason = getShutdownReason() || 'natural';
      console.info(`[Server] Process exit (code=${code}, reason=${reason}).`);
    });
  }

  let fatalHandled = false;
  const handleFatalError = (reason, detail) => {
    if (fatalHandled) return;
    if (isBrokenPipeError(detail)) {
      requestShutdown('stdio-epipe');
      return;
    }
    fatalHandled = true;
    console.error(`[Server] Fatal ${reason}: ${formatCrashDetail(detail)}`);
    requestShutdown(reason);
    const forceExitTimer = setTimeout(() => {
      console.error(`[Server] Forced exit after fatal ${reason}.`);
      process.exit(1);
    }, 5000);
    forceExitTimer.unref?.();
  };

  process.on('uncaughtException', (err) => {
    handleFatalError('uncaughtException', err);
  });
  process.on('unhandledRejection', (reason) => {
    handleFatalError('unhandledRejection', reason);
  });
}

function registerStdioShutdownHandlers(requestShutdown) {
  if (stdioShutdownHandlers) return;

  const onStdinEnd = () => requestShutdown('stdin-end');
  const onStdinClose = () => requestShutdown('stdin-close');
  const onStdoutError = (err) => {
    if (err?.code === 'EPIPE') {
      requestShutdown('stdout-epipe');
    }
  };
  const onStderrError = (err) => {
    if (err?.code === 'EPIPE') {
      requestShutdown('stderr-epipe');
    }
  };

  process.stdin?.on?.('end', onStdinEnd);
  process.stdin?.on?.('close', onStdinClose);
  process.stdout?.on?.('error', onStdoutError);
  process.stderr?.on?.('error', onStderrError);

  stdioShutdownHandlers = {
    onStdinEnd,
    onStdinClose,
    onStdoutError,
    onStderrError,
  };
}

function unregisterStdioShutdownHandlers() {
  if (!stdioShutdownHandlers) return;
  process.stdin?.off?.('end', stdioShutdownHandlers.onStdinEnd);
  process.stdin?.off?.('close', stdioShutdownHandlers.onStdinClose);
  process.stdout?.off?.('error', stdioShutdownHandlers.onStdoutError);
  process.stderr?.off?.('error', stdioShutdownHandlers.onStderrError);
  stdioShutdownHandlers = null;
}

async function resolveWorkspaceFromEnvValue(rawValue) {
  if (!rawValue || rawValue.includes('${')) return null;
  const resolved = path.resolve(rawValue);
  try {
    const stats = await fs.stat(resolved);
    if (!stats.isDirectory()) return null;
    return resolved;
  } catch {
    return null;
  }
}

async function detectRuntimeWorkspaceFromEnv() {
  for (const key of getWorkspaceEnvKeys()) {
    const workspacePath = await resolveWorkspaceFromEnvValue(process.env[key]);
    if (workspacePath) {
      return { workspacePath, envKey: key };
    }
  }

  return null;
}

function normalizePathForCompare(targetPath) {
  if (!targetPath) return '';
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveWorkspaceCacheDirectory(workspacePath, globalCacheRoot) {
  const candidates = getWorkspaceCachePathCandidates(workspacePath, globalCacheRoot);
  if (await pathExists(candidates.canonical)) {
    return { cacheDirectory: candidates.canonical, mode: 'canonical' };
  }
  if (
    candidates.compatDriveCase !== candidates.canonical &&
    (await pathExists(candidates.compatDriveCase))
  ) {
    return { cacheDirectory: candidates.compatDriveCase, mode: 'compat-drivecase' };
  }
  if (candidates.legacy !== candidates.canonical && (await pathExists(candidates.legacy))) {
    return { cacheDirectory: candidates.legacy, mode: 'legacy' };
  }
  return { cacheDirectory: candidates.canonical, mode: 'canonical' };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function findAutoAttachWorkspaceCandidate({ excludeCacheDirectory = null } = {}) {
  const cacheRoot = path.join(getGlobalCacheDir(), 'heuristic-mcp');
  const normalizedExclude = normalizePathForCompare(excludeCacheDirectory);

  let cacheDirs = [];
  try {
    cacheDirs = await fs.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidatesByWorkspace = new Map();
  const preferredWorkspaceFromEnv = (await detectRuntimeWorkspaceFromEnv())?.workspacePath ?? null;
  const normalizedPreferred = normalizePathForCompare(preferredWorkspaceFromEnv);

  const upsertCandidate = (candidate) => {
    const key = normalizePathForCompare(candidate.workspace);
    const existing = candidatesByWorkspace.get(key);
    if (!existing || candidate.rank > existing.rank) {
      candidatesByWorkspace.set(key, candidate);
    }
  };

  for (const entry of cacheDirs) {
    if (!entry.isDirectory()) continue;
    const cacheDirectory = path.join(cacheRoot, entry.name);
    if (normalizedExclude && normalizePathForCompare(cacheDirectory) === normalizedExclude)
      continue;

    const lockPath = path.join(cacheDirectory, 'server.lock.json');
    try {
      const rawLock = await fs.readFile(lockPath, 'utf-8');
      const lock = JSON.parse(rawLock);
      if (!isProcessAlive(lock?.pid)) continue;
      const workspace = path.resolve(lock?.workspace || '');
      if (!workspace || isNonProjectDirectory(workspace)) continue;
      const stats = await fs.stat(workspace).catch(() => null);
      if (!stats?.isDirectory()) continue;
      const rank = Date.parse(lock?.startedAt || '') || 0;
      upsertCandidate({
        workspace,
        cacheDirectory,
        source: `lock:${lock.pid}`,
        rank,
      });
      continue;
    } catch {}

    const metaPath = path.join(cacheDirectory, 'meta.json');
    try {
      const rawMeta = await fs.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(rawMeta);
      const workspace = path.resolve(meta?.workspace || '');
      if (!workspace || isNonProjectDirectory(workspace)) continue;
      const stats = await fs.stat(workspace).catch(() => null);
      if (!stats?.isDirectory()) continue;
      const filesIndexed = Number(meta?.filesIndexed || 0);
      if (filesIndexed <= 0) continue;
      const rank = Date.parse(meta?.lastSaveTime || '') || 0;
      upsertCandidate({
        workspace,
        cacheDirectory,
        source: 'meta',
        rank,
      });
    } catch {}
  }

  const candidates = Array.from(candidatesByWorkspace.values());
  if (candidates.length === 0) return null;
  if (normalizedPreferred) {
    const preferred = candidates.find(
      (candidate) => normalizePathForCompare(candidate.workspace) === normalizedPreferred
    );
    if (preferred) return preferred;
  }
  if (candidates.length === 1) return candidates[0];
  return null;
}

async function maybeAutoSwitchWorkspace(request) {
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') return null;
  if (!setWorkspaceFeatureInstance || !config?.searchDirectory) return null;
  if (request?.params?.name === 'f_set_workspace') return null;

  const detected = await detectRuntimeWorkspaceFromEnv();
  if (!detected) return null;
  if (isNonProjectDirectory(detected.workspacePath)) {
    console.info(
      `[Server] Ignoring auto-switch candidate from env ${detected.envKey}: non-project path ${detected.workspacePath}`
    );
    return null;
  }

  const currentWorkspace = normalizePathForCompare(config.searchDirectory);
  const detectedWorkspace = normalizePathForCompare(detected.workspacePath);
  if (detectedWorkspace === currentWorkspace) return detected.workspacePath;

  await maybeAutoSwitchWorkspaceToPath(detected.workspacePath, {
    source: `env ${detected.envKey}`,
    reindex: false,
  });
  return detected.workspacePath;
}

async function detectWorkspaceFromRoots({ quiet = false } = {}) {
  try {
    const caps = server.getClientCapabilities();
    if (!caps?.roots) {
      rootsCapabilitySupported = false;
      if (!quiet) {
        console.info(
          '[Server] Client does not support roots capability, skipping workspace auto-detection.'
        );
      }
      return null;
    }
    rootsCapabilitySupported = true;

    const result = await server.listRoots();
    if (!result?.roots?.length) {
      if (!quiet) {
        console.info('[Server] Client returned no roots.');
      }
      return null;
    }

    if (!quiet) {
      console.info(`[Server] MCP roots received: ${result.roots.map((r) => r.uri).join(', ')}`);
    }

    const rootPaths = result.roots
      .map((r) => r.uri)
      .filter((uri) => uri.startsWith('file://'))
      .map((uri) => {
        try {
          return fileURLToPath(uri);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (rootPaths.length === 0) {
      if (!quiet) {
        console.info('[Server] No valid file:// roots found.');
      }
      return null;
    }

    return path.resolve(rootPaths[0]);
  } catch (err) {
    if (!quiet) {
      console.warn(`[Server] MCP roots detection failed (non-fatal): ${err.message}`);
    }
    return null;
  }
}

async function maybeAutoSwitchWorkspaceToPath(
  targetWorkspacePath,
  { source, reindex = false } = {}
) {
  if (!setWorkspaceFeatureInstance || !config?.searchDirectory) return;
  if (!targetWorkspacePath) return;
  if (isNonProjectDirectory(targetWorkspacePath)) {
    if (config?.verbose) {
      console.info(
        `[Server] Ignoring auto-switch candidate from ${source || 'unknown'}: non-project path ${targetWorkspacePath}`
      );
    }
    return;
  }

  const currentWorkspace = normalizePathForCompare(config.searchDirectory);
  const targetWorkspace = normalizePathForCompare(targetWorkspacePath);
  if (targetWorkspace === currentWorkspace) return;

  if (autoWorkspaceSwitchPromise) {
    await autoWorkspaceSwitchPromise;
    const currentNow = normalizePathForCompare(config.searchDirectory);
    const targetNow = normalizePathForCompare(targetWorkspacePath);
    if (targetNow === currentNow) return;
  }

  const switchPromise = (async () => {
    const latestWorkspace = normalizePathForCompare(config.searchDirectory);
    console.info(
      `[Server] Auto-switching workspace from ${latestWorkspace} to ${targetWorkspacePath} (${source || 'auto'})`
    );
    const result = await setWorkspaceFeatureInstance.execute({
      workspacePath: targetWorkspacePath,
      reindex,
    });
    if (!result.success) {
      console.warn(`[Server] Auto workspace switch failed (${source || 'auto'}): ${result.error}`);
      return;
    }
    trustWorkspacePath(targetWorkspacePath);
  })();
  autoWorkspaceSwitchPromise = switchPromise;

  try {
    await switchPromise;
  } finally {
    if (autoWorkspaceSwitchPromise === switchPromise) {
      autoWorkspaceSwitchPromise = null;
    }
  }
}

async function maybeAutoSwitchWorkspaceFromRoots(request) {
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') return null;
  if (!setWorkspaceFeatureInstance || !config?.searchDirectory) return null;
  if (request?.params?.name === 'f_set_workspace') return null;
  if (rootsCapabilitySupported === false) return null;

  if (rootsProbeInFlight) {
    return await rootsProbeInFlight;
  }
  const now = Date.now();
  if (now - lastRootsProbeTime < ROOTS_PROBE_COOLDOWN_MS) return null;
  lastRootsProbeTime = now;

  rootsProbeInFlight = (async () => {
    const rootWorkspace = await detectWorkspaceFromRoots({ quiet: true });
    if (!rootWorkspace) return null;
    await maybeAutoSwitchWorkspaceToPath(rootWorkspace, {
      source: 'roots probe',
      reindex: false,
    });
    return rootWorkspace;
  })();

  try {
    return await rootsProbeInFlight;
  } finally {
    rootsProbeInFlight = null;
  }
}

const features = [
  {
    module: HybridSearchFeature,
    instance: null,
    handler: HybridSearchFeature.handleToolCall,
  },
  {
    module: IndexCodebaseFeature,
    instance: null,
    handler: IndexCodebaseFeature.handleToolCall,
  },
  {
    module: ClearCacheFeature,
    instance: null,
    handler: ClearCacheFeature.handleToolCall,
  },
  {
    module: FindSimilarCodeFeature,
    instance: null,
    handler: FindSimilarCodeFeature.handleToolCall,
  },
  {
    module: AnnConfigFeature,
    instance: null,
    handler: AnnConfigFeature.handleToolCall,
  },
  {
    module: PackageVersionFeature,
    instance: null,
    handler: PackageVersionFeature.handleToolCall,
  },
  {
    module: SetWorkspaceFeature,
    instance: null,
    handler: null,
  },
];

async function initialize(workspaceDir) {
  config = await loadConfig(workspaceDir);

  if (config.enableCache && config.cacheCleanup?.autoCleanup) {
    console.info('[Server] Running automatic cache cleanup...');
    const results = await clearStaleCaches({
      ...config.cacheCleanup,
      logger: console,
    });
    if (results.removed > 0) {
      console.info(
        `[Server] Removed ${results.removed} stale cache ${results.removed === 1 ? 'directory' : 'directories'}`
      );
    }
  }

  const isTest = isTestRuntime();
  if (config.enableExplicitGc && typeof global.gc !== 'function' && !isTest) {
    console.warn(
      '[Server] enableExplicitGc=true but this process was not started with --expose-gc; continuing with explicit GC disabled.'
    );
    console.warn(
      '[Server] Tip: start with "npm start" or add --expose-gc to enable explicit GC again.'
    );
    config.enableExplicitGc = false;
  }

  let mainBackendConfigured = false;
  let nativeOnnxAvailable = null;
  const ensureMainOnnxBackend = () => {
    if (mainBackendConfigured) return;
    nativeOnnxAvailable = configureNativeOnnxBackend({
      log: config.verbose ? console.info : null,
      label: '[Server]',
      threads: {
        intraOpNumThreads: ONNX_THREAD_LIMIT,
        interOpNumThreads: 1,
      },
    });
    mainBackendConfigured = true;
  };

  ensureMainOnnxBackend();
  if (nativeOnnxAvailable === false) {
    try {
      const { env } = await getTransformers();
      if (env?.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = ONNX_THREAD_LIMIT;
      }
    } catch {}
    const status = getNativeOnnxStatus();
    const reason = status?.message || 'onnxruntime-node not available';
    console.warn(`[Server] Native ONNX backend unavailable (${reason}); using WASM backend.`);
    console.warn(
      '[Server] Auto-safety: disabling workers and forcing embeddingProcessPerBatch for memory isolation.'
    );
    if (config.workerThreads !== 0) {
      config.workerThreads = 0;
    }
    if (!config.embeddingProcessPerBatch) {
      config.embeddingProcessPerBatch = true;
    }
  }
  const resolutionSource = config.workspaceResolution?.source || 'unknown';
  if (resolutionSource === 'workspace-arg' || resolutionSource === 'env') {
    trustWorkspacePath(config.searchDirectory);
  }
  const isSystemFallbackWorkspace =
    (resolutionSource === 'cwd' || resolutionSource === 'cwd-root-search') &&
    isNonProjectDirectory(config.searchDirectory);

  let pidPath = null;
  let logPath = null;
  if (isSystemFallbackWorkspace) {
    workspaceLockAcquired = false;
    console.warn(
      `[Server] System fallback workspace detected (${config.searchDirectory}); running in lightweight read-only mode.`
    );
    console.warn('[Server] Skipping lock/PID/log file setup for fallback workspace.');
  } else {
    if (config.autoStopOtherServersOnStartup !== false) {
      const globalCacheRoot = path.join(getGlobalCacheDir(), 'heuristic-mcp');
      const { killed, failed } = await stopOtherHeuristicServers({
        globalCacheRoot,
        currentCacheDirectory: config.cacheDirectory,
      });
      if (killed.length > 0) {
        const details = killed
          .map((entry) => `${entry.pid}${entry.workspace ? ` (${entry.workspace})` : ''}`)
          .join(', ');
        console.info(
          `[Server] Auto-stopped ${killed.length} stale heuristic-mcp server(s): ${details}`
        );
      }
      if (failed.length > 0) {
        const details = failed
          .map((entry) => `${entry.pid}${entry.workspace ? ` (${entry.workspace})` : ''}`)
          .join(', ');
        console.warn(
          `[Server] Failed to stop ${failed.length} older heuristic-mcp server(s): ${details}`
        );
      }
    }

    const lock = await acquireWorkspaceLock({
      cacheDirectory: config.cacheDirectory,
      workspaceDir: config.searchDirectory,
    });
    workspaceLockAcquired = lock.acquired;
    if (!workspaceLockAcquired) {
      console.warn(
        `[Server] Another heuristic-mcp instance is already running for this workspace (pid ${lock.ownerPid ?? 'unknown'}).`
      );
      console.warn(
        '[Server] Starting in secondary read-only mode: background indexing and cache writes are disabled for this instance.'
      );
    }
    [pidPath, logPath] = workspaceLockAcquired
      ? await Promise.all([
          setupPidFile({ pidFileName: PID_FILE_NAME, cacheDirectory: config.cacheDirectory }),
          setupFileLogging(config),
        ])
      : [null, await setupFileLogging(config)];
  }
  if (logPath) {
    console.info(`[Logs] Writing server logs to ${logPath}`);
    console.info(`[Logs] Log viewer: heuristic-mcp --logs --workspace "${config.searchDirectory}"`);
  }
  {
    const resolution = config.workspaceResolution || {};
    const sourceLabel =
      resolution.source === 'env' && resolution.envKey
        ? `env:${resolution.envKey}`
        : resolution.source || 'unknown';
    const baseLabel = resolution.baseDirectory || '(unknown)';
    const searchLabel = resolution.searchDirectory || config.searchDirectory;
    const overrideLabel = resolution.searchDirectoryFromConfig ? 'yes' : 'no';
    console.info(
      `[Server] Workspace resolved: source=${sourceLabel}, base=${baseLabel}, search=${searchLabel}, configOverride=${overrideLabel}`
    );
    if (resolution.fromPath) {
      console.info(`[Server] Workspace resolution origin cwd: ${resolution.fromPath}`);
    }

    const workspaceEnvProbe = Array.isArray(resolution.workspaceEnvProbe)
      ? resolution.workspaceEnvProbe
      : [];
    if (workspaceEnvProbe.length > 0) {
      const probePreview = workspaceEnvProbe.slice(0, 8).map((entry) => {
        const scope = entry?.priority ? 'priority' : 'diagnostic';
        const status = entry?.resolvedPath
          ? `valid:${entry.resolvedPath}`
          : `invalid:${entry?.value}`;
        return `${entry?.key}[${scope}]=${status}`;
      });
      const suffix = workspaceEnvProbe.length > 8 ? ` (+${workspaceEnvProbe.length - 8} more)` : '';
      console.info(`[Server] Workspace env probe: ${probePreview.join('; ')}${suffix}`);
    }
  }

  console.info(
    `[Server] Config: workerThreads=${config.workerThreads}, embeddingProcessPerBatch=${config.embeddingProcessPerBatch}`
  );
  console.info(
    `[Server] Config: vectorStoreLoadMode=${config.vectorStoreLoadMode}, vectorCacheEntries=${config.vectorCacheEntries}`
  );

  if (pidPath) {
    console.info(`[Server] PID file: ${pidPath}`);
  }

  try {
    const globalCache = path.join(getGlobalCacheDir(), 'heuristic-mcp');
    const localCache = path.join(process.cwd(), '.heuristic-mcp');
    console.info(`[Server] Cache debug: Global=${globalCache}, Local=${localCache}`);
    console.info(`[Server] Process CWD: ${process.cwd()}`);
    console.info(
      `[Server] Resolved workspace: ${config.searchDirectory} (via ${config.workspaceResolution?.source || 'unknown'})`
    );
  } catch (_e) {}

  let stopStartupMemory = null;
  if (config.verbose) {
    logMemory('[Server] Memory (startup)');
    stopStartupMemory = startMemoryLogger('[Server] Memory (startup)', MEMORY_LOG_INTERVAL_MS);
  }

  try {
    await fs.access(config.searchDirectory);
  } catch {
    console.error(`[Server] Error: Search directory "${config.searchDirectory}" does not exist`);
    process.exit(1);
  }

  console.info('[Server] Initializing features...');
  let cachedEmbedderPromise = null;
  const lazyEmbedder = async (...args) => {
    if (!cachedEmbedderPromise) {
      ensureMainOnnxBackend();
      console.info(`[Server] Loading AI embedding model: ${config.embeddingModel}...`);
      const modelLoadStart = Date.now();
      const { pipeline } = await getTransformers();
      cachedEmbedderPromise = pipeline('feature-extraction', config.embeddingModel, {
        quantized: true,
        dtype: 'fp32',
        session_options: {
          numThreads: 2,
          intraOpNumThreads: 2,
          interOpNumThreads: 2,
        },
      }).then((model) => {
        const loadSeconds = ((Date.now() - modelLoadStart) / 1000).toFixed(1);
        console.info(
          `[Server] Embedding model loaded (${loadSeconds}s). Starting intensive indexing (expect high CPU)...`
        );
        console.info(`[Server] Embedding model ready: ${config.embeddingModel}`);
        if (config.verbose) {
          logMemory('[Server] Memory (after model load)');
        }
        return model;
      });
    }
    const model = await cachedEmbedderPromise;
    return model(...args);
  };

  const unloader = async () => {
    if (!cachedEmbedderPromise) return false;
    try {
      const model = await cachedEmbedderPromise;
      if (model && typeof model.dispose === 'function') {
        await model.dispose();
      }
      cachedEmbedderPromise = null;
      if (typeof global.gc === 'function') {
        global.gc();
      }
      if (config.verbose) {
        logMemory('[Server] Memory (after model unload)');
      }
      console.info('[Server] Embedding model unloaded to free memory.');
      return true;
    } catch (err) {
      console.warn(`[Server] Error unloading embedding model: ${err.message}`);
      cachedEmbedderPromise = null;
      return false;
    }
  };

  embedder = lazyEmbedder;
  unloadMainEmbedder = unloader;
  const preloadEmbeddingModel = async () => {
    if (config.preloadEmbeddingModel === false) return;
    try {
      console.info('[Server] Preloading embedding model (background)...');
      await embedder(' ');
    } catch (err) {
      console.warn(`[Server] Embedding model preload failed: ${err.message}`);
    }
  };

  if (config.vectorStoreFormat === 'binary') {
    try {
      await cleanupStaleBinaryArtifacts(config.cacheDirectory, { logger: console });
    } catch (err) {
      console.warn(`[Cache] Startup temp cleanup failed: ${err.message}`);
    }
  }

  cache = new EmbeddingsCache(config);
  assertCacheContract(cache);
  console.info(`[Server] Cache directory: ${config.cacheDirectory}`);

  indexer = new CodebaseIndexer(embedder, cache, config, server);
  hybridSearch = new HybridSearch(embedder, cache, config);
  const cacheClearer = new ClearCacheFeature.CacheClearer(embedder, cache, config, indexer);
  const findSimilarCode = new FindSimilarCodeFeature.FindSimilarCode(embedder, cache, config);
  const annConfig = new AnnConfigFeature.AnnConfigTool(cache, config);

  features[0].instance = hybridSearch;
  features[1].instance = indexer;
  features[2].instance = cacheClearer;
  features[3].instance = findSimilarCode;
  features[4].instance = annConfig;

  const setWorkspaceInstance = new SetWorkspaceFeature.SetWorkspaceFeature(
    config,
    cache,
    indexer,
    getGlobalCacheDir
  );
  setWorkspaceFeatureInstance = setWorkspaceInstance;
  features[6].instance = setWorkspaceInstance;
  features[6].handler = SetWorkspaceFeature.createHandleToolCall(setWorkspaceInstance);

  server.hybridSearch = hybridSearch;

  const startBackgroundTasks = async () => {
    const stopStartupMemoryLogger = () => {
      if (stopStartupMemory) {
        stopStartupMemory();
      }
    };
    const handleCorruptCacheAfterLoad = async ({ context, canReindex }) => {
      if (!cache.consumeAutoReindex()) return false;
      cache.clearInMemoryState();
      await recordBinaryStoreCorruption(config.cacheDirectory, {
        context,
        action: canReindex ? 'auto-cleared' : 'secondary-readonly-blocked',
      });
      if (canReindex) {
        console.warn(
          `[Server] Cache corruption detected while ${context}; in-memory cache was cleared and a full re-index will run.`
        );
      } else {
        console.warn(
          `[Server] Cache corruption detected while ${context}. This server is secondary read-only and cannot re-index. Restart the MCP client session for this workspace or use the primary instance to rebuild the cache.`
        );
      }
      return true;
    };
    const tryAutoAttachWorkspaceCache = async (
      reason,
      { canReindex = workspaceLockAcquired } = {}
    ) => {
      const candidate = await findAutoAttachWorkspaceCandidate({
        excludeCacheDirectory: config.cacheDirectory,
      });
      if (!candidate) {
        console.warn(
          `[Server] Auto-attach skipped (${reason}): no unambiguous workspace cache candidate found.`
        );
        return false;
      }

      config.searchDirectory = candidate.workspace;
      config.cacheDirectory = candidate.cacheDirectory;
      await fs.mkdir(config.cacheDirectory, { recursive: true });
      if (config.vectorStoreFormat === 'binary') {
        await cleanupStaleBinaryArtifacts(config.cacheDirectory, { logger: console });
      }
      await cache.load();
      await handleCorruptCacheAfterLoad({
        context: `auto-attaching workspace cache (${reason})`,
        canReindex,
      });
      console.info(
        `[Server] Auto-attached workspace cache (${reason}): ${candidate.workspace} via ${candidate.source}`
      );
      if (config.verbose) {
        logMemory('[Server] Memory (after cache load)');
      }
      return true;
    };

    const resolutionSource = config.workspaceResolution?.source || 'unknown';
    const isSystemFallback =
      (resolutionSource === 'cwd' || resolutionSource === 'cwd-root-search') &&
      isNonProjectDirectory(config.searchDirectory);

    if (isSystemFallback) {
      try {
        console.warn(
          `[Server] Detected system fallback workspace: ${config.searchDirectory}. Attempting cache auto-attach.`
        );
        const attached = await tryAutoAttachWorkspaceCache('system-fallback', {
          canReindex: workspaceLockAcquired,
        });
        if (!attached) {
          console.warn(
            '[Server] Waiting for a proper workspace root (MCP roots, env vars, or f_set_workspace).'
          );
        }
      } finally {
        stopStartupMemoryLogger();
      }
      return;
    }

    if (!workspaceLockAcquired) {
      try {
        console.info('[Server] Secondary instance detected; loading cache in read-only mode.');
        await cache.load();
        await handleCorruptCacheAfterLoad({
          context: 'loading cache in secondary read-only mode',
          canReindex: false,
        });
        const storeSize = cache.getStoreSize();
        if (storeSize === 0) {
          await tryAutoAttachWorkspaceCache('secondary-empty-cache', { canReindex: false });
        }
        if (config.verbose) {
          logMemory('[Server] Memory (after cache load)');
        }
      } finally {
        stopStartupMemoryLogger();
      }
      console.info('[Server] Secondary instance ready; skipping background indexing.');
      return;
    }

    void preloadEmbeddingModel();

    try {
      console.info('[Server] Loading cache (deferred)...');
      await cache.load();
      await handleCorruptCacheAfterLoad({ context: 'startup cache load', canReindex: true });
      if (config.verbose) {
        logMemory('[Server] Memory (after cache load)');
      }
    } finally {
      stopStartupMemoryLogger();
    }

    console.info('[Server] Starting background indexing (delayed)...');

    setTimeout(() => {
      indexer
        .indexAll()
        .then(() => {
          if (config.watchFiles) {
            indexer.setupFileWatcher();
          }
        })
        .catch((err) => {
          console.error('[Server] Background indexing error:', err.message);
        });
    }, BACKGROUND_INDEX_DELAY_MS);
  };

  return { startBackgroundTasks, config };
}

const server = new Server(
  {
    name: 'heuristic-mcp',
    version: packageJson.version,
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
  console.info('[Server] Received roots/list_changed notification from client.');
  const newRoot = await detectWorkspaceFromRoots();
  if (newRoot) {
    await maybeAutoSwitchWorkspaceToPath(newRoot, {
      source: 'roots changed',
      reindex: false,
    });
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  await configReadyPromise;
  if (configInitError || !config) {
    throw configInitError ?? new Error('Server configuration is not initialized');
  }
  return await handleListResources(config);
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  await configReadyPromise;
  if (configInitError || !config) {
    throw configInitError ?? new Error('Server configuration is not initialized');
  }
  return await handleReadResource(request.params.uri, config);
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  await configReadyPromise;
  if (configInitError || !config) {
    throw configInitError ?? new Error('Server configuration is not initialized');
  }
  const tools = [];

  for (const feature of features) {
    const toolDef = feature.module.getToolDefinition(config);
    tools.push(toolDef);
  }

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await configReadyPromise;
  if (configInitError || !config) {
    return {
      content: [
        {
          type: 'text',
          text: `Server initialization failed: ${configInitError?.message || 'configuration not available'}`,
        },
      ],
      isError: true,
    };
  }

  if (!workspaceLockAcquired && request.params?.name === 'f_set_workspace') {
    const args = request.params?.arguments || {};
    const workspacePath = args.workspacePath;
    const reindex = args.reindex !== false;
    if (typeof workspacePath !== 'string' || workspacePath.trim().length === 0) {
      return {
        content: [{ type: 'text', text: 'Error: workspacePath is required.' }],
        isError: true,
      };
    }
    if (reindex) {
      return {
        content: [
          {
            type: 'text',
            text: 'This server instance is in secondary read-only mode. Set reindex=false to attach cache only.',
          },
        ],
        isError: true,
      };
    }
    const normalizedPath = path.resolve(workspacePath);
    try {
      const stats = await fs.stat(normalizedPath);
      if (!stats.isDirectory()) {
        return {
          content: [{ type: 'text', text: `Error: Path is not a directory: ${normalizedPath}` }],
          isError: true,
        };
      }
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Cannot access directory ${normalizedPath}: ${err.message}`,
          },
        ],
        isError: true,
      };
    }

    config.searchDirectory = normalizedPath;
    const cacheResolution = await resolveWorkspaceCacheDirectory(normalizedPath, getGlobalCacheDir());
    config.cacheDirectory = cacheResolution.cacheDirectory;
    if (config.verbose || cacheResolution.mode !== 'canonical') {
      console.info(`[Server] Cache resolution mode: ${cacheResolution.mode}`);
    }
    try {
      await fs.mkdir(config.cacheDirectory, { recursive: true });
      await cache.load();
      if (cache.consumeAutoReindex()) {
        cache.clearInMemoryState();
        await recordBinaryStoreCorruption(config.cacheDirectory, {
          context: 'f_set_workspace read-only attach',
          action: 'secondary-readonly-blocked',
        });
        return {
          content: [
            {
              type: 'text',
              text: `Attached cache for ${normalizedPath}, but it is corrupt. This secondary read-only instance cannot rebuild it. Restart the MCP client session for this workspace or run indexing from the primary instance.`,
            },
          ],
          isError: true,
        };
      }
      trustWorkspacePath(normalizedPath);
      return {
        content: [
          {
            type: 'text',
            text: `Attached in read-only mode to workspace cache: ${normalizedPath}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Failed to attach cache for ${normalizedPath}: ${err.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (
    !workspaceLockAcquired &&
    ['b_index_codebase', 'c_clear_cache'].includes(request.params?.name)
  ) {
    return {
      content: [
        {
          type: 'text',
          text: 'This server instance is in secondary read-only mode. Use the primary instance for indexing/cache mutation tools.',
        },
      ],
      isError: true,
    };
  }
  const detectedFromRoots = await maybeAutoSwitchWorkspaceFromRoots(request);
  const detectedFromEnv = await maybeAutoSwitchWorkspace(request);
  if (detectedFromRoots) {
    trustWorkspacePath(detectedFromRoots);
  }
  if (detectedFromEnv) {
    trustWorkspacePath(detectedFromEnv);
  }

  const toolName = request.params?.name;
  if (
    config.requireTrustedWorkspaceSignalForTools === true &&
    shouldRequireTrustedWorkspaceSignalForTool(toolName) &&
    !detectedFromRoots &&
    !detectedFromEnv &&
    !isCurrentWorkspaceTrusted()
  ) {
    return {
      content: [
        {
          type: 'text',
          text:
            `Workspace context appears stale for "${toolName}" (current: "${config.searchDirectory}"). ` +
            'Please reload your IDE window and retry. ' +
            'If needed, call MCP tool "f_set_workspace" from your chat/client with your opened folder path.',
        },
      ],
      isError: true,
    };
  }

  for (const feature of features) {
    const toolDef = feature.module.getToolDefinition(config);

    if (request.params.name === toolDef.name) {
      if (typeof feature.handler !== 'function') {
        return {
          content: [
            {
              type: 'text',
              text: `Tool "${toolDef.name}" is not ready. Server may still be initializing.`,
            },
          ],
          isError: true,
        };
      }
      let result;
      try {
        result = await feature.handler(request, feature.instance);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Server] Tool ${toolDef.name} failed: ${message}`);
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${message || 'Unknown tool failure'}`,
            },
          ],
          isError: true,
        };
      }
      if (toolDef.name === 'f_set_workspace' && !isToolResponseError(result)) {
        trustWorkspacePath(config.searchDirectory);
      }

      const searchTools = ['a_semantic_search', 'd_find_similar_code'];
      if (config.unloadModelAfterSearch && searchTools.includes(toolDef.name)) {
        setImmediate(() => {
          const unloadFn = unloadMainEmbedder;
          if (typeof unloadFn !== 'function') return;
          void Promise.resolve()
            .then(() => unloadFn())
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              console.warn(`[Server] Post-search model unload failed: ${message}`);
            });
        });
      }

      return result;
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: `Unknown tool: ${request.params.name}`,
      },
    ],
    isError: true,
  };
});

export async function main(argv = process.argv) {
  const parsed = parseArgs(argv);
  const {
    isServerMode,
    workspaceDir,
    wantsVersion,
    wantsHelp,
    wantsLogs,
    wantsMem,
    wantsNoFollow,
    tailLines,
    wantsStop,
    wantsStart,
    wantsCache,
    wantsClean,
    wantsStatus,
    wantsClearCache,
    startFilter,
    wantsFix,
    unknownFlags,
  } = parsed;

  let shutdownRequested = false;
  let shutdownReason = 'natural';
  const requestShutdown = (reason) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    shutdownReason = String(reason || 'unknown');
    console.info(`[Server] Shutdown requested (${reason}).`);
    void gracefulShutdown(reason);
  };
  const isTestEnv = isTestRuntime();
  registerProcessDiagnostics({
    isServerMode,
    requestShutdown,
    getShutdownReason: () => shutdownReason,
  });

  if (isServerMode && !isTestEnv) {
    enableStderrOnlyLogging();
  }
  if (wantsVersion) {
    console.info(packageJson.version);
    process.exit(0);
  }

  if (wantsHelp) {
    printHelp();
    process.exit(0);
  }

  if (workspaceDir) {
    console.info(`[Server] Workspace mode: ${workspaceDir}`);
  }

  if (wantsStop) {
    await stop();
    process.exit(0);
  }

  if (wantsStart) {
    await start(startFilter);
    process.exit(0);
  }

  if (wantsStatus) {
    await status({ fix: wantsFix, workspaceDir });
    process.exit(0);
  }

  if (wantsCache) {
    await status({ fix: wantsClean, cacheOnly: true, workspaceDir });
    process.exit(0);
  }

  const clearIndex = parsed.rawArgs.indexOf('--clear');
  if (clearIndex !== -1) {
    const cacheId = parsed.rawArgs[clearIndex + 1];
    if (cacheId && !cacheId.startsWith('--')) {
      let cacheHome;
      if (process.platform === 'win32') {
        cacheHome = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      } else if (process.platform === 'darwin') {
        cacheHome = path.join(os.homedir(), 'Library', 'Caches');
      } else {
        cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
      }
      const globalCacheRoot = path.join(cacheHome, 'heuristic-mcp');
      const trimmedId = String(cacheId).trim();
      const hasSeparators = trimmedId.includes('/') || trimmedId.includes('\\');
      const resolvedCachePath = path.resolve(globalCacheRoot, trimmedId);
      const relPath = path.relative(globalCacheRoot, resolvedCachePath);
      const isWithinRoot = relPath && !relPath.startsWith('..') && !path.isAbsolute(relPath);

      if (!trimmedId || hasSeparators || !isWithinRoot) {
        console.error(`[Cache] ❌ Invalid cache id: ${cacheId}`);
        console.error('[Cache] Cache id must be a direct child of the cache root.');
        process.exit(1);
      }

      const cachePath = resolvedCachePath;

      try {
        await fs.access(cachePath);
        console.info(`[Cache] Removing cache: ${cacheId}`);
        console.info(`[Cache] Path: ${cachePath}`);
        await fs.rm(cachePath, { recursive: true, force: true });
        console.info(`[Cache] ✅ Successfully removed cache ${cacheId}`);
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.error(`[Cache] ❌ Cache not found: ${cacheId}`);
          console.error(`[Cache] Available caches in ${globalCacheRoot}:`);
          const dirs = await fs.readdir(globalCacheRoot).catch(() => []);
          dirs.forEach((dir) => console.error(`   - ${dir}`));
          process.exit(1);
        } else {
          console.error(`[Cache] ❌ Failed to remove cache: ${error.message}`);
          process.exit(1);
        }
      }
      process.exit(0);
    }
  }

  if (wantsClearCache) {
    await clearCache(workspaceDir);
    process.exit(0);
  }

  if (wantsLogs) {
    process.env.SMART_CODING_LOGS = 'true';
    process.env.SMART_CODING_VERBOSE = 'true';
    await logs({
      workspaceDir,
      tailLines,
      follow: !wantsNoFollow,
    });
    process.exit(0);
  }

  if (wantsMem) {
    const ok = await printMemorySnapshot(workspaceDir);
    process.exit(ok ? 0 : 1);
  }

  if (unknownFlags.length > 0) {
    console.error(`[Error] Unknown option(s): ${unknownFlags.join(', ')}`);
    printHelp();
    process.exit(1);
  }

  if (wantsFix && !wantsStatus) {
    console.error('[Error] --fix can only be used with --status (deprecated, use --cache --clean)');
    printHelp();
    process.exit(1);
  }

  if (wantsClean && !wantsCache) {
    console.error('[Error] --clean can only be used with --cache');
    printHelp();
    process.exit(1);
  }

  registerSignalHandlers(requestShutdown);

  const detectedRootPromise = isTestEnv
    ? Promise.resolve(null)
    : new Promise((resolve) => {
        const HANDSHAKE_TIMEOUT_MS = 1000;
        let settled = false;
        const resolveOnce = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };

        const timer = setTimeout(() => {
          console.warn(
            `[Server] MCP handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms, proceeding without roots.`
          );
          resolveOnce(null);
        }, HANDSHAKE_TIMEOUT_MS);

        server.oninitialized = async () => {
          clearTimeout(timer);
          console.info('[Server] MCP handshake complete.');
          const root = await detectWorkspaceFromRoots();
          resolveOnce(root);
        };
      });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.info('[Server] MCP transport connected.');
  if (isServerMode) {
    registerStdioShutdownHandlers(requestShutdown);
  }

  const detectedRoot = await detectedRootPromise;

  const effectiveWorkspace = detectedRoot || workspaceDir;
  if (detectedRoot) {
    console.info(`[Server] Using workspace from MCP roots: ${detectedRoot}`);
  }
  let startBackgroundTasks;
  try {
    const initResult = await initialize(effectiveWorkspace);
    startBackgroundTasks = initResult.startBackgroundTasks;
  } catch (err) {
    configInitError = err;
    configReadyResolve();
    throw err;
  }

  console.info('[Server] Heuristic MCP server started.');

  try {
    await startBackgroundTasks();
  } catch (err) {
    console.error(`[Server] Background task error: ${err.message}`);
  }
  configReadyResolve();
  // Keep-Alive mechanism: ensure the process stays alive even if StdioServerTransport
  // temporarily loses its active handle status or during complex async chains.
  if (isServerMode && !isTestEnv && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => {
      // Logic to keep event loop active.
      // We don't need to do anything, just the presence of the timer is enough.
    }, SERVER_KEEP_ALIVE_INTERVAL_MS);
  }

  console.info('[Server] MCP server is now fully ready to accept requests.');
}

async function gracefulShutdown(signal) {
  console.info(`[Server] Received ${signal}, shutting down gracefully...`);
  const exitCode = getShutdownExitCode(signal);

  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  const indexerIsBusy =
    indexer &&
    (typeof indexer.isBusy === 'function'
      ? indexer.isBusy()
      : Boolean(indexer.isIndexing || indexer.processingWatchEvents));
  if (indexerIsBusy && typeof indexer.requestGracefulStop === 'function') {
    const waitMs =
      Number.isInteger(config?.shutdownIndexWaitMs) && config.shutdownIndexWaitMs >= 0
        ? config.shutdownIndexWaitMs
        : 3000;
    try {
      indexer.requestGracefulStop(`shutdown:${signal}`);
      if (typeof indexer.waitForIdle === 'function') {
        const waitResult = await indexer.waitForIdle(waitMs);
        if (waitResult?.idle) {
          console.info('[Server] Shutdown checkpoint outcome: success');
        } else {
          console.warn(`[Server] Shutdown checkpoint outcome: timeout (${waitMs}ms)`);
        }
      }
    } catch (err) {
      console.warn(`[Server] Shutdown checkpoint outcome: failed (${err.message})`);
    }
  }

  const cleanupTasks = [];

  if (indexer && indexer.watcher) {
    cleanupTasks.push(
      indexer.watcher
        .close()
        .then(() => console.info('[Server] File watcher stopped'))
        .catch(() => console.warn('[Server] Error closing watcher'))
    );
  }

  if (indexer && indexer.terminateWorkers) {
    cleanupTasks.push(
      (async () => {
        console.info('[Server] Terminating workers...');
        await indexer.terminateWorkers();
        console.info('[Server] Workers terminated');
      })().catch(() => console.info('[Server] Workers shutdown (with warnings)'))
    );
  }

  if (cache) {
    cleanupTasks.push(
      (async () => {
        if (!workspaceLockAcquired) {
          console.info('[Server] Secondary/fallback mode: skipping cache save.');
        } else {
          await cache.save();
          console.info('[Server] Cache saved');
        }
        if (typeof cache.close === 'function') {
          await cache.close();
        }
      })().catch((err) => console.error(`[Server] Cache shutdown cleanup failed: ${err.message}`))
    );
  }

  if (workspaceLockAcquired && config?.cacheDirectory) {
    cleanupTasks.push(
      releaseWorkspaceLock({ cacheDirectory: config.cacheDirectory }).catch((err) =>
        console.warn(`[Server] Failed to release workspace lock: ${err.message}`)
      )
    );
  }

  await Promise.allSettled(cleanupTasks);
  console.info('[Server] Goodbye!');

  unregisterStdioShutdownHandlers();
  await flushLogsSafely({ close: true, timeoutMs: 1500 });

  setTimeout(() => process.exit(exitCode), 100);
}

function isLikelyCliEntrypoint(argvPath) {
  const base = path.basename(argvPath || '').toLowerCase();
  return (
    base === 'heuristic-mcp' ||
    base === 'heuristic-mcp.js' ||
    base === 'heuristic-mcp.mjs' ||
    base === 'heuristic-mcp.cjs' ||
    base === 'heuristic-mcp.cmd'
  );
}

const isMain =
  process.argv[1] &&
  (path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() ||
    isLikelyCliEntrypoint(process.argv[1])) &&
  !(process.env.VITEST === 'true' || process.env.NODE_ENV === 'test');

if (isMain) {
  main().catch(async (err) => {
    console.error(err);
    await flushLogsSafely({ close: true, timeoutMs: 500 });
    process.exit(1);
  });
}
