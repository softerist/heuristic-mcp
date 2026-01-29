/**
 * Ensure the code-review workflow includes the required production-ready guidance.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const workflowPath = path.join(repoRoot, '.agent', 'workflows', 'code-review.md');

async function readWorkflow() {
  return fs.readFile(workflowPath, 'utf8');
}

describe('Code Review Workflow', () => {
  it('includes scope control and line-by-line expectations', async () => {
    const content = await readWorkflow();

    expect(content).toContain('Review Scope & Context');
    expect(content).toContain('For code <100 lines');
    expect(content).toContain('For code >500 lines or critical systems');
    expect(content).toContain('Review every function and critical code path');
    expect(content).toContain('Group line-by-line findings by severity');
  });

  it('includes fix plan effort scale and dependency tracking', async () => {
    const content = await readWorkflow();

    expect(content).toContain('Estimated effort per item');
    expect(content).toContain('S (Small)');
    expect(content).toContain('M (Medium)');
    expect(content).toContain('L (Large)');
    expect(content).toContain('Requires #N');
  });

  it('includes patch, tests, length control, and follow-up guidance', async () => {
    const content = await readWorkflow();

    expect(content).toContain('unified diff format');
    expect(content).toContain('ALL critical severity issues');
    expect(content).toContain('unit tests');
    expect(content).toContain('integration tests');
    expect(content).toContain('Length Control');
    expect(content).toContain('Follow-up Reviews');
    expect(content).toContain('regression verification');
  });
});
