import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { createTestFixtures, cleanupFixtures, waitFor } from './helpers.js';
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

    await fixtures.indexer.indexAll();

    const storeAfterFirstIndex = fixtures.cache.getVectorStore();
    expect(storeAfterFirstIndex.length).toBeGreaterThan(0);

    const preFilterSpy = vi.spyOn(fixtures.indexer, 'preFilterFiles');
    await fixtures.indexer.indexAll();

    expect(preFilterSpy).toHaveBeenCalled();
    const filesToProcess = await preFilterSpy.mock.results[0].value;
    expect(filesToProcess).toHaveLength(0);
  });

  it('detects newly added files after full index', async () => {
    fixtures = await createTestFixtures({ workerThreads: 0 });
    fixtures.config.verbose = true;

    await fixtures.indexer.indexAll();

    const newFile = path.join(fixtures.searchDir, 'brand-new.js');
    await fs.writeFile(newFile, 'export const brandNew = true;\n');

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

    await fixtures.indexer.indexAll();

    const allFiles = await fixtures.indexer.discoverFiles();

    const fileToForget = allFiles[0];
    fixtures.cache.fileHashes.delete(fileToForget);

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

    await fixtures.indexer.indexAll();

    const modifiedFile = path.join(fixtures.searchDir, 'test.js');
    const originalContent = await fs.readFile(modifiedFile, 'utf8');
    await fs.writeFile(modifiedFile, originalContent + '\n// modified\n');

    const preFilterSpy = vi.spyOn(fixtures.indexer, 'preFilterFiles');
    await fixtures.indexer.indexAll();

    expect(preFilterSpy).toHaveBeenCalled();
    const filesToProcess = await preFilterSpy.mock.results[0].value;
    expect(filesToProcess.length).toBe(1);
    expect(filesToProcess[0].file).toContain('test.js');
  });

  it('checkpoint-saves on graceful stop and resumes only remaining files after restart', async () => {
    fixtures = await createTestFixtures({ workerThreads: 0 });
    fixtures.config.verbose = true;
    fixtures.config.batchSize = 1;
    fixtures.config.indexCheckpointIntervalMs = 0;

    for (let i = 0; i < 25; i += 1) {
      const filePath = path.join(fixtures.searchDir, `extra-${i}.js`);
      await fs.writeFile(filePath, `export const value${i} = ${i};\n`);
    }

    const saveSpy = vi.spyOn(fixtures.cache, 'save');
    const firstRunPromise = fixtures.indexer.indexAll();
    const indexingStarted = await waitFor(() => fixtures.indexer.isIndexing === true, 5000, 25);
    expect(indexingStarted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 50));
    fixtures.indexer.requestGracefulStop('test-interrupt');
    const idleResult = await fixtures.indexer.waitForIdle(15000);
    expect(idleResult.idle).toBe(true);

    const firstRun = await firstRunPromise;
    expect(firstRun.stoppedEarly).toBe(true);
    expect(saveSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    const { EmbeddingsCache } = await import('../lib/cache.js');
    const { CodebaseIndexer } = await import('../features/index-codebase.js');
    const resumedCache = new EmbeddingsCache(fixtures.config);
    await resumedCache.load();
    const resumedIndexer = new CodebaseIndexer(fixtures.embedder, resumedCache, fixtures.config, null);

    const resumedRun = await resumedIndexer.indexAll();
    expect(resumedRun.filesProcessed).toBeGreaterThan(0);

    const preFilterSpy = vi.spyOn(resumedIndexer, 'preFilterFiles');
    await resumedIndexer.indexAll();
    const filesToProcess = await preFilterSpy.mock.results[0].value;
    expect(filesToProcess).toHaveLength(0);

    await resumedIndexer.terminateWorkers();
  });
});
