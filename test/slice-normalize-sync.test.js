import { describe, it, expect } from 'vitest';
import { sliceAndNormalize } from '../lib/slice-normalize.js';

describe('sliceAndNormalize synchronization', () => {
  function workerSliceAndNormalize(vector, targetDim) {
    if (!targetDim || targetDim >= vector.length) {
      return vector;
    }
    const sliced = vector.slice(0, targetDim);
    let sumSquares = 0;
    for (let i = 0; i < targetDim; i++) {
      sumSquares += sliced[i] * sliced[i];
    }
    const norm = Math.sqrt(sumSquares);
    if (norm > 0) {
      for (let i = 0; i < targetDim; i++) {
        sliced[i] /= norm;
      }
    }
    return sliced;
  }

  it('should produce identical results for various inputs', () => {
    const testCases = [
      { vector: new Float32Array([1, 2, 3, 4, 5]), targetDim: 3 },
      { vector: new Float32Array([0.1, 0.2, 0.3, 0.4]), targetDim: 2 },
      { vector: new Float32Array([1, 0, 0, 0]), targetDim: 2 },
      { vector: new Float32Array([0, 0, 0, 0]), targetDim: 2 },
      { vector: new Float32Array([0.5, -0.5, 0.5, -0.5]), targetDim: 3 },
    ];

    for (const { vector, targetDim } of testCases) {
      const libResult = sliceAndNormalize(vector, targetDim);
      const workerResult = workerSliceAndNormalize(vector, targetDim);

      expect(libResult.length).toBe(workerResult.length);
      for (let i = 0; i < libResult.length; i++) {
        expect(libResult[i]).toBeCloseTo(workerResult[i], 6);
      }
    }
  });

  it('should return original vector when targetDim is null or >= vector length', () => {
    const vector = new Float32Array([1, 2, 3]);

    const libResult1 = sliceAndNormalize(vector, null);
    const workerResult1 = workerSliceAndNormalize(vector, null);
    expect(libResult1).toBe(vector);
    expect(workerResult1).toBe(vector);

    const libResult2 = sliceAndNormalize(vector, 5);
    const workerResult2 = workerSliceAndNormalize(vector, 5);
    expect(libResult2).toBe(vector);
    expect(workerResult2).toBe(vector);
  });

  it('should normalize sliced vectors to unit length', () => {
    const vector = new Float32Array([3, 4, 5, 6]);
    const targetDim = 2;

    const libResult = sliceAndNormalize(vector, targetDim);
    const workerResult = workerSliceAndNormalize(vector, targetDim);

    const libMagnitude = Math.sqrt(libResult[0] ** 2 + libResult[1] ** 2);
    const workerMagnitude = Math.sqrt(workerResult[0] ** 2 + workerResult[1] ** 2);

    expect(libMagnitude).toBeCloseTo(1.0, 6);
    expect(workerMagnitude).toBeCloseTo(1.0, 6);
  });

  it('should handle zero vector without NaN', () => {
    const vector = new Float32Array([0, 0, 0, 0]);
    const result = sliceAndNormalize(vector, 2);
    expect(result.every((v) => !Number.isNaN(v))).toBe(true);
    expect(result.every((v) => v === 0)).toBe(true);
  });
});
