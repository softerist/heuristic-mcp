/**
 * Centralized path normalization utilities for cross-platform consistency.
 * Addresses Issue #13 from code review: inconsistent path normalization.
 */

import path from 'path';

/**
 * Normalize a file path for consistent comparison.
 * Converts backslashes to forward slashes and lowercases on Windows.
 * @param {string} value - Path to normalize
 * @returns {string} Normalized path suitable for comparison
 */
export function normalizePath(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Check if a target path is inside a base directory.
 * @param {string} basePath - Base directory path
 * @param {string} targetPath - Path to check
 * @returns {boolean} True if targetPath is inside basePath
 */
export function isPathInside(basePath, targetPath) {
  const normalizedBase = normalizePath(basePath);
  const normalizedTarget = normalizePath(targetPath);
  const relative = path.relative(normalizedBase, normalizedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Normalize a path for use as a cache key or map lookup.
 * @param {string} filePath - Path to normalize
 * @returns {string} Normalized path key
 */
export function normalizePathKey(filePath) {
  return normalizePath(filePath);
}
