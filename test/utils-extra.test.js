import { describe, it, expect, afterEach } from 'vitest';
import { smartChunk, MODEL_TOKEN_LIMITS } from '../lib/utils.js';

describe('utils.js extra coverage', () => {
  const originalLimits = { ...MODEL_TOKEN_LIMITS };

  afterEach(() => {
    for (const key in MODEL_TOKEN_LIMITS) delete MODEL_TOKEN_LIMITS[key];
    Object.assign(MODEL_TOKEN_LIMITS, originalLimits);
  });

  it('handles multi-line comment start (line 198 coverage)', () => {
    const content = 'const a = 1; /* start comment\n end comment */ const b = 2;';
    const config = { embeddingModel: 'test-model' };

    const chunks = smartChunk(content, 'test.js', config);
    expect(chunks.length).toBeGreaterThan(0);

    expect(chunks[0].text).toContain('const a = 1');
    expect(chunks[0].text).toContain('const b = 2');
  });

  it('flushes current chunk when encountering oversized line (line 255 coverage)', () => {
    MODEL_TOKEN_LIMITS['test-oversize'] = 20;

    const line1 = 'const small = 1; // padding to exceed 20 chars';

    const line2 = 'x '.repeat(50);

    const content = `${line1}\n${line2}`;
    const config = { embeddingModel: 'test-oversize' };

    const chunks = smartChunk(content, 'test.js', config);

    expect(chunks[0].text.trim()).toBe(line1);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('stops overlap calculation when limit is reached (line 309 coverage)', () => {
    MODEL_TOKEN_LIMITS['test-overlap'] = 100;

    const line = 'const val = 123456;';

    const lines = Array(20).fill(line);
    const content = lines.join('\n');
    const config = { embeddingModel: 'test-overlap' };

    const chunks = smartChunk(content, 'test.js', config);

    expect(chunks.length).toBeGreaterThan(1);
  });

  it('handles oversized line with empty chunk (line 255 false path coverage)', () => {
    MODEL_TOKEN_LIMITS['test-oversize-empty'] = 20;

    const hugeLine = 'x '.repeat(50);
    const content = hugeLine;
    const config = { embeddingModel: 'test-oversize-empty' };

    const chunks = smartChunk(content, 'test.js', config);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text.length).toBeGreaterThan(0);
  });

  it('terminates overlap loop when limit is exactly reached (line 309 loop condition coverage)', () => {
    MODEL_TOKEN_LIMITS['test-overlap-exact'] = 100;

    const line = 'a b c';

    const lines = Array(30).fill(line);
    const content = lines.join('\n');
    const config = { embeddingModel: 'test-overlap-exact' };

    const chunks = smartChunk(content, 'test.js', config);

    expect(chunks.length).toBeGreaterThan(1);
  });
});
