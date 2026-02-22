import { afterEach, describe, expect, it } from 'vitest';
import {
  getDriveLetterCompatWorkspaceCacheKey,
  getWorkspaceCacheKey,
  getWorkspaceCachePathCandidates,
} from '../lib/workspace-cache-key.js';

const ORIGINAL_PLATFORM = process.platform;

function withWindowsPlatform() {
  Object.defineProperty(process, 'platform', { value: 'win32' });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM });
});

describe('workspace-cache-key', () => {
  it('normalizes full path casing on Windows for canonical key', () => {
    withWindowsPlatform();
    const a = getWorkspaceCacheKey('C:\\Users\\Test\\MyRepo');
    const b = getWorkspaceCacheKey('c:\\users\\test\\myrepo');
    expect(a).toBe(b);
  });

  it('preserves old drive-letter-only behavior for compatibility key', () => {
    withWindowsPlatform();
    const a = getDriveLetterCompatWorkspaceCacheKey('C:\\Users\\Test\\MyRepo');
    const b = getDriveLetterCompatWorkspaceCacheKey('c:\\users\\test\\myrepo');
    expect(a).not.toBe(b);
  });

  it('returns canonical, compat, and legacy cache path candidates', () => {
    withWindowsPlatform();
    const candidates = getWorkspaceCachePathCandidates('C:\\Users\\Test\\MyRepo', 'C:\\CacheRoot');
    expect(candidates.canonical).toContain('heuristic-mcp');
    expect(candidates.compatDriveCase).toContain('heuristic-mcp');
    expect(candidates.legacy).toContain('heuristic-mcp');
  });
});

