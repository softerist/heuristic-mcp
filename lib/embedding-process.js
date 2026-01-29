import { pipeline, env } from '@xenova/transformers';

// Keep output clean for IPC
const log = (...args) => {
  if (process.env.EMBEDDING_PROCESS_VERBOSE === 'true') {
    // eslint-disable-next-line no-console
    console.error(...args);
  }
};

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function toFloat32Array(vector) {
  if (vector instanceof Float32Array) return vector;
  return Float32Array.from(vector);
}

async function main() {
  const raw = await readStdin();
  if (!raw) return;

  const payload = JSON.parse(raw);
  const {
    embeddingModel,
    chunks,
    numThreads = 1,
  } = payload;

  env.backends.onnx.wasm.numThreads = numThreads;
  env.backends.onnx.numThreads = numThreads;

  log(`[Child] Loading model ${embeddingModel}...`);
  const embedder = await pipeline('feature-extraction', embeddingModel, {
    quantized: true,
  });
  log('[Child] Model ready');

  const results = [];
  for (const chunk of chunks || []) {
    try {
      const output = await embedder(chunk.text, { pooling: 'mean', normalize: true });
      const vector = toFloat32Array(output.data);
      results.push({
        file: chunk.file,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.text,
        vector: Array.from(vector),
        success: true,
      });
    } catch (error) {
      results.push({
        file: chunk.file,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        error: error.message,
        success: false,
      });
    }
  }

  process.stdout.write(JSON.stringify({ results }));
}

main().catch((err) => {
  process.stderr.write(String(err?.message || err));
  process.exit(1);
});
