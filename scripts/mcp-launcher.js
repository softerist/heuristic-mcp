import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DYNAMIC_WORKSPACE_ENV_PREFIX,
  WORKSPACE_ENV_KEY_PATTERN,
  WORKSPACE_ENV_VARS,
} from '../lib/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const indexPath = path.join(repoRoot, 'index.js');

let workspace;
const passthrough = [];

function scoreWorkspaceEnvKey(key) {
  const upper = String(key || '').toUpperCase();
  let score = 0;
  if (upper.includes('WORKSPACE')) score += 8;
  if (upper.includes('PROJECT')) score += 4;
  if (upper.includes('ROOT')) score += 3;
  if (upper.includes('CWD')) score += 2;
  if (upper.includes('DIR')) score += 1;
  return score;
}

function getDynamicCodexWorkspaceKeys() {
  return Object.keys(process.env)
    .filter((key) => key.startsWith(DYNAMIC_WORKSPACE_ENV_PREFIX))
    .filter((key) => WORKSPACE_ENV_KEY_PATTERN.test(key))
    .filter((key) => !WORKSPACE_ENV_VARS.includes(key))
    .sort((a, b) => scoreWorkspaceEnvKey(b) - scoreWorkspaceEnvKey(a));
}

function readWorkspaceFromEnv() {
  for (const key of WORKSPACE_ENV_VARS) {
    const value = process.env[key];
    if (!value || value.includes('${')) continue;
    return value;
  }
  for (const key of getDynamicCodexWorkspaceKeys()) {
    const value = process.env[key];
    if (!value || value.includes('${')) continue;
    return value;
  }
  return null;
}

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--workspace' && i + 1 < process.argv.length) {
    workspace = process.argv[i + 1];
    i += 1;
    continue;
  }
  passthrough.push(arg);
}

if (!workspace) {
  workspace = readWorkspaceFromEnv();
}

if (!workspace) {
  workspace = process.cwd();
}

const args = ['--expose-gc', indexPath, '--workspace', workspace, ...passthrough];
const child = spawn(process.execPath, args, { stdio: 'inherit' });

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
