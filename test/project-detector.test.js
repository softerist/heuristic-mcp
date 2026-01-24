/**
 * Tests for ProjectDetector
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ProjectDetector } from '../lib/project-detector.js';

async function withTempDir(testFn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heuristic-detector-'));
  try {
    await testFn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('ProjectDetector', () => {
  it('returns empty when directory is missing', async () => {
    const detector = new ProjectDetector(path.join(os.tmpdir(), 'does-not-exist'));
    const types = await detector.detectProjectTypes();
    expect(types).toEqual([]);
  });

  it('detects wildcard markers like *.csproj', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'app.csproj'), '<Project />');
      const detector = new ProjectDetector(dir);
      const types = await detector.detectProjectTypes();

      expect(types).toContain('dotnet');

      const summary = detector.getSummary();
      expect(summary.detectedTypes).toContain('dotnet');
      expect(summary.patternCount).toBeGreaterThan(0);
    });
  });

  it('does not recurse past depth limit', async () => {
    await withTempDir(async (dir) => {
      const deepDir = path.join(dir, 'a', 'b', 'c');
      await fs.mkdir(deepDir, { recursive: true });
      await fs.writeFile(path.join(deepDir, 'package.json'), '{}');

      const detector = new ProjectDetector(dir);
      const types = await detector.detectProjectTypes();

      expect(types).not.toContain('javascript');
    });
  });

  it('short-circuits when startDepth exceeds maxDepth', async () => {
    await withTempDir(async (dir) => {
      const detector = new ProjectDetector(dir);
      const types = await detector.detectProjectTypes({
        startDepth: 3,
        maxDepth: 2,
      });

      expect(types).toEqual([]);
    });
  });
});
