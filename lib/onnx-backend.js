import { env } from '@huggingface/transformers';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const IS_TEST_ENV = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

let ort = null;
let ortLoadError = null;
try {
  ort = await import('onnxruntime-node');
} catch (e) {
  ortLoadError = e;
}

let ortVersion = null;
let expectedOrtVersion = null;
try {
  ortVersion = require('onnxruntime-node/package.json')?.version || null;
} catch {
  ortVersion = null;
}
try {
  const transformersPkg = require('@huggingface/transformers/package.json');
  expectedOrtVersion =
    transformersPkg?.optionalDependencies?.['onnxruntime-node'] ||
    transformersPkg?.dependencies?.['onnxruntime-node'] ||
    null;
} catch {
  expectedOrtVersion = null;
}

let executionProviders = null;
let ONNX = null;
if (!IS_TEST_ENV) {
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    const backend = await dynamicImport('@huggingface/transformers/src/backends/onnx.js');
    executionProviders = backend.executionProviders;
    ONNX = backend.ONNX;
  } catch {}
}

let sessionThreadOptions = null;
let originalCreate = null;
let createPatched = false;

export function getNativeOnnxStatus() {
  if (typeof process === 'undefined' || process?.release?.name !== 'node') {
    return { available: false, reason: 'not_node' };
  }
  if (ortVersion && expectedOrtVersion) {
    const actualParts = String(ortVersion).split('.');
    const expectedParts = String(expectedOrtVersion)
      .replace(/^[^0-9]*/, '')
      .split('.');
    const actualMajor = Number(actualParts[0] || 0);
    const actualMinor = Number(actualParts[1] || 0);
    const expectedMajor = Number(expectedParts[0] || 0);
    const expectedMinor = Number(expectedParts[1] || 0);
    if (
      Number.isFinite(actualMajor) &&
      Number.isFinite(actualMinor) &&
      Number.isFinite(expectedMajor) &&
      Number.isFinite(expectedMinor) &&
      (actualMajor !== expectedMajor || actualMinor !== expectedMinor)
    ) {
      return {
        available: false,
        reason: 'version_mismatch',
        message: `onnxruntime-node ${ortVersion} incompatible with transformers.js expectation ${expectedOrtVersion}`,
      };
    }
  }
  if (!ort?.InferenceSession) {
    return {
      available: false,
      reason: 'unavailable',
      error: ortLoadError,
      message: ortLoadError?.message || 'onnxruntime-node not available',
    };
  }
  return { available: true };
}

function normalizeThreadOptions(threads) {
  if (threads == null) return null;
  if (typeof threads === 'number') {
    const value = Number.isFinite(threads) ? Math.floor(threads) : null;
    if (value && value > 0) return { intraOpNumThreads: value };
    return null;
  }
  if (typeof threads !== 'object') return null;
  const intra = Number.isFinite(threads.intraOpNumThreads)
    ? Math.floor(threads.intraOpNumThreads)
    : null;
  const inter = Number.isFinite(threads.interOpNumThreads)
    ? Math.floor(threads.interOpNumThreads)
    : null;
  const normalized = {};
  if (intra && intra > 0) normalized.intraOpNumThreads = intra;
  if (inter && inter > 0) normalized.interOpNumThreads = inter;
  return Object.keys(normalized).length ? normalized : null;
}

function isOptionsCandidate(value) {
  if (!value || typeof value !== 'object') return false;
  if (ArrayBuffer.isView(value)) return false;
  if (value instanceof ArrayBuffer) return false;
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) return false;
  return true;
}

function findOptionsIndex(args) {
  if (isOptionsCandidate(args[1])) return 1;
  if (typeof args[1] === 'number') {
    if (isOptionsCandidate(args[2])) return 2;
    if (typeof args[2] === 'number' && isOptionsCandidate(args[3])) return 3;
  }
  return -1;
}

function patchInferenceSessionCreate() {
  if (createPatched || !ONNX?.InferenceSession?.create) return false;
  originalCreate = ONNX.InferenceSession.create.bind(ONNX.InferenceSession);
  ONNX.InferenceSession.create = (...args) => {
    if (sessionThreadOptions) {
      const optionsIndex = findOptionsIndex(args);
      if (optionsIndex >= 0) {
        const merged = { ...args[optionsIndex] };
        if (merged.intraOpNumThreads == null && sessionThreadOptions.intraOpNumThreads != null) {
          merged.intraOpNumThreads = sessionThreadOptions.intraOpNumThreads;
        }
        if (merged.interOpNumThreads == null && sessionThreadOptions.interOpNumThreads != null) {
          merged.interOpNumThreads = sessionThreadOptions.interOpNumThreads;
        }
        args[optionsIndex] = merged;
      } else {
        args.push({ ...sessionThreadOptions });
      }
    }
    return originalCreate(...args);
  };
  createPatched = true;
  return true;
}

export function configureNativeOnnxBackend({ log, label, threads } = {}) {
  const status = getNativeOnnxStatus();
  if (!status.available) {
    if (log) {
      const msg = status.message || status.reason || 'onnxruntime-node not available';
      log(
        `${label ? `${label} ` : ''}Native ONNX backend unavailable: ${msg}. Falling back to WASM.`
      );
    }
    return false;
  }

  if (Array.isArray(executionProviders)) {
    if (executionProviders.length !== 1 || executionProviders[0] !== 'cpu') {
      executionProviders.length = 0;
      executionProviders.push('cpu');
    }
  }

  if (env.backends?.onnx?.wasm && typeof env.backends.onnx.wasm === 'object') {
    env.backends.onnx.wasm.proxy = false;
  }

  const normalizedThreads = normalizeThreadOptions(threads);
  if (normalizedThreads) {
    sessionThreadOptions = normalizedThreads;
    patchInferenceSessionCreate();
    if (log) {
      const intra = normalizedThreads.intraOpNumThreads ?? 'default';
      const inter = normalizedThreads.interOpNumThreads ?? 'default';
      log(
        `${label ? `${label} ` : ''}ONNX session threads set (intraOp=${intra}, interOp=${inter})`
      );
    }
  }

  if (log) {
    log(`${label ? `${label} ` : ''}ONNX backend set to onnxruntime-node (cpu)`);
  }

  return true;
}
