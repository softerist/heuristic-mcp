/**
 * MCP Resources Feature
 *
 * Exposes workspace files as MCP resources for discovery and reading.
 */

import fs from 'fs/promises';
import path from 'path';
import { fdir } from 'fdir';
import { getMimeType } from '../lib/constants.js';

/**
 * Convert a file path to a file:// URI.
 * @param {string} filePath - Absolute file path
 * @returns {string}
 */
function pathToUri(filePath) {
  // Normalize path separators and encode for URI
  const normalized = filePath.replace(/\\/g, '/');
  // On Windows, paths start with drive letter like C:/
  if (/^[a-zA-Z]:/.test(normalized)) {
    return `file:///${normalized}`;
  }
  return `file://${normalized}`;
}

/**
 * Convert a file:// URI back to a file path.
 * @param {string} uri
 * @returns {string}
 */
function uriToPath(uri) {
  if (!uri.startsWith('file://')) {
    throw new Error(`Invalid file URI: ${uri}`);
  }
  let filePath = uri.slice(7); // Remove 'file://'
  // Handle Windows paths (file:///C:/...)
  if (/^\/[a-zA-Z]:/.test(filePath)) {
    filePath = filePath.slice(1); // Remove leading /
  }
  // Decode URI components
  filePath = decodeURIComponent(filePath);
  // Normalize to OS path separators
  if (process.platform === 'win32') {
    filePath = filePath.replace(/\//g, '\\');
  }
  return filePath;
}

/**
 * Check if a path is within the workspace directory.
 * @param {string} filePath - Absolute file path
 * @param {string} workspaceDir - Workspace directory
 * @returns {boolean}
 */
function isWithinWorkspace(filePath, workspaceDir) {
  const resolvedPath = path.resolve(filePath);
  const resolvedWorkspace = path.resolve(workspaceDir);
  const relativePath = path.relative(resolvedWorkspace, resolvedPath);
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

/**
 * List resources handler for MCP.
 * @param {object} config - Server configuration
 * @returns {Promise<{resources: Array}>}
 */
export async function handleListResources(config) {
  const workspaceDir = config.searchDirectory;
  const maxResults = 500; // Limit to avoid overwhelming clients

  // Build set of allowed extensions from config
  const allowedExtensions = new Set(
    (config.fileExtensions || []).map(ext => `.${ext.toLowerCase()}`)
  );

  // Extract directory names from exclude patterns (e.g., '**/node_modules/**' -> 'node_modules')
  const excludedDirs = new Set();
  for (const pattern of config.excludePatterns || []) {
    // Match patterns like '**/dirname/**' or 'dirname/**'
    const match = pattern.match(/(?:\*\*\/)?([^/*]+)(?:\/\*\*)?$/);
    if (match && match[1] && !match[1].includes('*')) {
      excludedDirs.add(match[1]);
    }
  }

  try {
    // Use fdir to scan workspace
    const crawler = new fdir()
      .withBasePath()
      .withMaxDepth(10)
      .exclude((dirName) => {
        return excludedDirs.has(dirName);
      })
      .filter((filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        return allowedExtensions.has(ext);
      })
      .crawl(workspaceDir);

    const files = await crawler.withPromise();
    const limitedFiles = files.slice(0, maxResults);

    const resources = limitedFiles.map((filePath) => {
      const relativePath = path.relative(workspaceDir, filePath);
      return {
        uri: pathToUri(filePath),
        name: relativePath.replace(/\\/g, '/'),
        mimeType: getMimeType(path.extname(filePath)),
      };
    });

    return { resources };
  } catch (error) {
    console.error(`[Resources] Error listing resources: ${error.message}`);
    return { resources: [] };
  }
}

/**
 * Read resource handler for MCP.
 * @param {string} uri - Resource URI
 * @param {object} config - Server configuration
 * @returns {Promise<{contents: Array}>}
 */
export async function handleReadResource(uri, config) {
  const workspaceDir = config.searchDirectory;

  try {
    const filePath = uriToPath(uri);

    // Security check: ensure path is within workspace
    if (!isWithinWorkspace(filePath, workspaceDir)) {
      throw new Error(`Access denied: ${uri} is outside workspace`);
    }

    // Check file exists
    await fs.access(filePath);

    // Read file content
    const content = await fs.readFile(filePath, 'utf-8');

    return {
      contents: [
        {
          uri,
          mimeType: getMimeType(path.extname(filePath)),
          text: content,
        },
      ],
    };
  } catch (error) {
    console.error(`[Resources] Error reading resource ${uri}: ${error.message}`);
    throw error;
  }
}
