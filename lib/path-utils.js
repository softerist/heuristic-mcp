

import path from 'path';


export function normalizePath(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}


export function isPathInside(basePath, targetPath) {
  const normalizedBase = normalizePath(basePath);
  const normalizedTarget = normalizePath(targetPath);
  const relative = path.relative(normalizedBase, normalizedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}


export function normalizePathKey(filePath) {
  return normalizePath(filePath);
}
