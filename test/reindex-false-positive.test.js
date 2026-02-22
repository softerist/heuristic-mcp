import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { createTestFixtures, cleanupFixtures } from './helpers.js';
import fs from 'fs/promises';
import path from 'path';

describe('Reindex false-positive prevention', () => {
  let fixtures;

  afterAll(async () => {
    if (fixtures) await cleanupFixtures(fixtures);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 0 changed files when revisiting a fully-indexed workspace', async () => {
    fixtures = await createTestFixtures({ workerThreads: 0 });
    fixtures.config.verbose = true;

    // Phase 1: Full index — all files should be processed
    await fixtures.indexer.indexAll();

    const storeAfterFirstIndex = fixtures.cache.getVectorStore();
    expect(storeAfterFirstIndex.length).toBeGreaterThan(0);

    // Phase 2: Simulate "return to workspace" — call indexAll again
    // without clearing cache (exactly what startup does)
    const preFilterSpy = vi.spyOn(fixtures.indexer, 'preFilterFiles');
    await fixtures.indexer.indexAll();

    // preFilterFiles should have been called and should return 0 files
    expect(preFilterSpy).toHaveBeenCalled();
    const filesToProcess = await preFilterSpy.mock.results[0].value;
    expect(filesToProcess).toHaveLength(0);
  });

  it('detects newly added files after full index', async () => {
    fixtures = await createTestFixtures({ workerThreads: 0 });
    fixtures.config.verbose = true;

    // Phase 1: Full index
    await fixtures.indexer.indexAll();

    // Phase 2: Add a new file
    const newFile = path.join(fixtures.searchDir, 'brand-new.js');
    await fs.writeFile(newFile, 'export const brandNew = true;\n');

    // Phase 3: Re-index should pick up only the new file
    const preFilterSpy = vi.spyOn(fixtures.indexer, 'preFilterFiles');
    await fixtures.indexer.indexAll();

    expect(preFilterSpy).toHaveBeenCalled();
    const filesToProcess = await preFilterSpy.mock.results[0].value;
    expect(filesToProcess.length).toBe(1);
    expect(filesToProcess[0].file).toContain('brand-new.js');
  });

  it('resumes partial index after interrupted session', async () => {
    fixtures = await createTestFixtures({ workerThreads: 0 });
    fixtures.config.verbose = true;

    // Phase 1: Full index to populate cache
    await fixtures.indexer.indexAll();

    const allFiles = await fixtures.indexer.discoverFiles();

    // Phase 2: Simulate partial cache — remove hash for one file
    // (as if the previous session was killed before indexing it)
    const fileToForget = allFiles[0];
    fixtures.cache.fileHashes.delete(fileToForget);

    // Phase 3: Re-index should pick up only the forgotten file
    const preFilterSpy = vi.spyOn(fixtures.indexer, 'preFilterFiles');
    await fixtures.indexer.indexAll();

    expect(preFilterSpy).toHaveBeenCalled();
    const filesToProcess = await preFilterSpy.mock.results[0].value;
    expect(filesToProcess.length).toBe(1);
    expect(filesToProcess[0].file).toBe(fileToForget);
  });

  it('re-indexes only modified files', async () => {
    fixtures = await createTestFixtures({ workerThreads: 0 });
    fixtures.config.verbose = true;

    // Phase 1: Full index
    await fixtures.indexer.indexAll();

    // Phase 2: Modify one file (touch it to change mtime & content)
    const modifiedFile = path.join(fixtures.searchDir, 'test.js');
    const originalContent = await fs.readFile(modifiedFile, 'utf8');
    await fs.writeFile(modifiedFile, originalContent + '\n// modified\n');

    // Phase 3: Only the modified file should be re-indexed
    const preFilterSpy = vi.spyOn(fixtures.indexer, 'preFilterFiles');
    await fixtures.indexer.indexAll();

    expect(preFilterSpy).toHaveBeenCalled();
    const filesToProcess = await preFilterSpy.mock.results[0].value;
    expect(filesToProcess.length).toBe(1);
    expect(filesToProcess[0].file).toContain('test.js');
  });
});
