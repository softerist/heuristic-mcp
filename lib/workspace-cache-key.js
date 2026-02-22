import crypto from 'crypto';
import path from 'path';

export function normalizeWorkspacePathForCacheKey(workspacePath) {
  const resolved = path.resolve(workspacePath);
  if (process.platform !== 'win32') {
    return resolved;
  }

  // Windows paths are case-insensitive. Normalize the whole path so casing
  // changes (including folder segments) map to one cache key.
  return resolved.toLowerCase();
}

export function normalizeWorkspacePathForCompatDriveLetterKey(workspacePath) {
  const resolved = path.resolve(workspacePath);
  if (process.platform !== 'win32') {
    return resolved;
  }

  // Compatibility behavior used by older versions: normalize drive letter
  // casing only.
  if (/^[A-Za-z]:/.test(resolved)) {
    return `${resolved[0].toLowerCase()}${resolved.slice(1)}`;
  }
  return resolved;
}

export function getWorkspaceCacheKey(workspacePath) {
  const normalized = normalizeWorkspacePathForCacheKey(workspacePath);
  return crypto.createHash('md5').update(normalized).digest('hex').slice(0, 12);
}

export function getDriveLetterCompatWorkspaceCacheKey(workspacePath) {
  const normalized = normalizeWorkspacePathForCompatDriveLetterKey(workspacePath);
  return crypto.createHash('md5').update(normalized).digest('hex').slice(0, 12);
}

export function getLegacyWorkspaceCacheKey(workspacePath) {
  const resolved = path.resolve(workspacePath);
  return crypto.createHash('md5').update(resolved).digest('hex').slice(0, 12);
}

export function getWorkspaceCachePath(workspacePath, globalCacheRoot) {
  return path.join(globalCacheRoot, 'heuristic-mcp', getWorkspaceCacheKey(workspacePath));
}

export function getDriveLetterCompatWorkspaceCachePath(workspacePath, globalCacheRoot) {
  return path.join(
    globalCacheRoot,
    'heuristic-mcp',
    getDriveLetterCompatWorkspaceCacheKey(workspacePath)
  );
}

export function getLegacyWorkspaceCachePath(workspacePath, globalCacheRoot) {
  return path.join(globalCacheRoot, 'heuristic-mcp', getLegacyWorkspaceCacheKey(workspacePath));
}

export function getWorkspaceCachePathCandidates(workspacePath, globalCacheRoot) {
  return {
    canonical: getWorkspaceCachePath(workspacePath, globalCacheRoot),
    compatDriveCase: getDriveLetterCompatWorkspaceCachePath(workspacePath, globalCacheRoot),
    legacy: getLegacyWorkspaceCachePath(workspacePath, globalCacheRoot),
  };
}
