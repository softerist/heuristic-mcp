import fs from 'fs/promises';
import path from 'path';
import { fdir } from 'fdir';
import { getMimeType } from '../lib/constants.js';

function pathToUri(filePath) {
  const normalized = filePath.replace(/\\/g, '/');

  if (/^[a-zA-Z]:/.test(normalized)) {
    return `file:///${normalized}`;
  }
  return `file://${normalized}`;
}

function uriToPath(uri) {
  if (!uri.startsWith('file://')) {
    throw new Error(`Invalid file URI: ${uri}`);
  }
  let filePath = uri.slice(7);

  if (/^\/[a-zA-Z]:/.test(filePath)) {
    filePath = filePath.slice(1);
  }

  filePath = decodeURIComponent(filePath);

  if (process.platform === 'win32') {
    filePath = filePath.replace(/\//g, '\\');
  }
  return filePath;
}

function isWithinWorkspace(filePath, workspaceDir) {
  const resolvedPath = path.resolve(filePath);
  const resolvedWorkspace = path.resolve(workspaceDir);
  const relativePath = path.relative(resolvedWorkspace, resolvedPath);
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

export async function handleListResources(config) {
  const workspaceDir = config.searchDirectory;
  const maxResults = 500;

  const allowedExtensions = new Set(
    (config.fileExtensions || []).map((ext) => `.${ext.toLowerCase()}`)
  );

  const excludedDirs = new Set();
  for (const pattern of config.excludePatterns || []) {
    const match = pattern.match(/(?:\*\*\/)?([^/*]+)(?:\/\*\*)?$/);
    if (match && match[1] && !match[1].includes('*')) {
      excludedDirs.add(match[1]);
    }
  }

  try {
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

export async function handleReadResource(uri, config) {
  const workspaceDir = config.searchDirectory;

  try {
    const filePath = uriToPath(uri);

    if (!isWithinWorkspace(filePath, workspaceDir)) {
      throw new Error(`Access denied: ${uri} is outside workspace`);
    }

    await fs.access(filePath);

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
