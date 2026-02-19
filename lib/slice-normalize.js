
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


export function toFloat32Array(vector) {
  
  
  return new Float32Array(vector);
}
