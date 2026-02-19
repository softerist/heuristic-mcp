import crypto from 'crypto';
import path from 'path';

export function normalizeWorkspacePathForCacheKey(workspacePath) {
  const resolved = path.resolve(workspacePath);
  if (process.platform !== 'win32') {
    return resolved;
  }

  // Windows paths are case-insensitive for drive letters; normalize only the
  // drive prefix so F:\repo and f:\repo map to the same cache key while
  // preserving existing segment casing for backward compatibility.
  if (/^[A-Za-z]:/.test(resolved)) {
    return `${resolved[0].toLowerCase()}${resolved.slice(1)}`;
  }

  return resolved;
}

export function getWorkspaceCacheKey(workspacePath) {
  const normalized = normalizeWorkspacePathForCacheKey(workspacePath);
  return crypto.createHash('md5').update(normalized).digest('hex').slice(0, 12);
}

export function getLegacyWorkspaceCacheKey(workspacePath) {
  const resolved = path.resolve(workspacePath);
  return crypto.createHash('md5').update(resolved).digest('hex').slice(0, 12);
}

export function getWorkspaceCachePath(workspacePath, globalCacheRoot) {
  return path.join(globalCacheRoot, 'heuristic-mcp', getWorkspaceCacheKey(workspacePath));
}

export function getLegacyWorkspaceCachePath(workspacePath, globalCacheRoot) {
  return path.join(globalCacheRoot, 'heuristic-mcp', getLegacyWorkspaceCacheKey(workspacePath));
}
