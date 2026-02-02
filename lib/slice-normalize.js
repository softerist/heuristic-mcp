/**
 * Slice and L2-normalize a vector for MRL (Matryoshka Representation Learning).
 * If targetDim is null/undefined or >= vector length, returns the original vector unchanged.
 * @param {Float32Array} vector - The full embedding vector
 * @param {number|null} targetDim - Target dimension (64/128/256/512/768 or null)
 * @returns {Float32Array} - Sliced and normalized vector, or original if no slicing
 */
export function sliceAndNormalize(vector, targetDim) {
  if (!targetDim || targetDim >= vector.length) {
    return vector;
  }

  // Slice to target dimension
  const sliced = vector.slice(0, targetDim);

  // L2 normalize the sliced vector
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

/**
 * Convert any array-like to Float32Array (always creates a copy).
 * @param {ArrayLike<number>} vector - Input vector
 * @returns {Float32Array} - Copy as Float32Array
 */
export function toFloat32Array(vector) {
  // Always create a copy to ensure we have a unique buffer
  // and avoid issues with reusable WASM memory views
  return new Float32Array(vector);
}
