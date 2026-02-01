import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const indexPath = path.join(repoRoot, 'index.js');

let workspace;
const passthrough = [];

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
  workspace = repoRoot;
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
