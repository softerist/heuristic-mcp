
export function sliceAndNormalize(vector, targetDim) {
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
