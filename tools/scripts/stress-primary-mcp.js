import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = process.cwd();
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const config = {
    workspace: path.join(repoRoot, '.tmp-mcp-stress-workspace'),
    prepareWorkspace: true,
    initialForce: true,
    rounds: 4,
    filesPerRound: 45,
  };

  let workspaceWasProvided = false;
  let initialForceWasProvided = false;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workspace' && argv[i + 1]) {
      config.workspace = path.resolve(argv[i + 1]);
      workspaceWasProvided = true;
      i += 1;
      continue;
    }
    if (arg === '--prepare-workspace' && argv[i + 1]) {
      config.prepareWorkspace = argv[i + 1] === 'true';
      i += 1;
      continue;
    }
    if (arg === '--initial-force' && argv[i + 1]) {
      config.initialForce = argv[i + 1] === 'true';
      initialForceWasProvided = true;
      i += 1;
      continue;
    }
    if (arg === '--rounds' && argv[i + 1]) {
      config.rounds = Number.parseInt(argv[i + 1], 10) || config.rounds;
      i += 1;
      continue;
    }
    if (arg === '--files-per-round' && argv[i + 1]) {
      config.filesPerRound = Number.parseInt(argv[i + 1], 10) || config.filesPerRound;
      i += 1;
      continue;
    }
  }

  if (workspaceWasProvided && !initialForceWasProvided) {
    // Full repo force reindex is very heavy; default to incremental unless explicitly requested.
    config.initialForce = false;
  }

  return config;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getText(result) {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content
    .filter((entry) => entry?.type === 'text')
    .map((entry) => entry.text)
    .join('\n');
}

async function churnFiles(stressDir, round, count) {
  await fs.mkdir(stressDir, { recursive: true });
  const writes = [];
  for (let i = 0; i < count; i += 1) {
    const file = path.join(stressDir, `round_${round}_file_${i}.txt`);
    const token = `STRESS_TOKEN_ROUND_${round}_FILE_${i}`;
    const content = [`round=${round}`, `file=${i}`, token, `time=${new Date().toISOString()}`].join(
      '\n'
    );
    writes.push(fs.writeFile(file, content, 'utf8'));
  }
  await Promise.all(writes);

  const mutations = [];
  for (let i = 0; i < count; i += 5) {
    const file = path.join(stressDir, `round_${round}_file_${i}.txt`);
    mutations.push(fs.appendFile(file, '\nupdated=true\n', 'utf8'));
  }
  await Promise.all(mutations);

  const deletes = [];
  for (let i = 3; i < count; i += 11) {
    const file = path.join(stressDir, `round_${round}_file_${i}.txt`);
    deletes.push(fs.rm(file, { force: true }));
  }
  await Promise.all(deletes);
}

async function ensureWorkspace(workspace) {
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'tmp-mcp-stress-workspace', version: '1.0.0' }, null, 2),
    'utf8'
  );

  const config = `{
  // Dedicated stress workspace config: fast indexing + aggressive idle timeout.
  "searchDirectory": ".",
  "watchFiles": false,
  "verbose": true,
  "batchSize": 20,
  "fileExtensions": ["txt", "js", "md", "json"],
  "embeddingPoolIdleTimeoutMs": 2000,
  "memoryCleanup": {
    "embeddingPoolIdleTimeoutMs": 2000
  }
}
`;
  await fs.writeFile(path.join(workspace, 'config.jsonc'), config, 'utf8');
}

async function callTool(client, name, args, timeout = REQUEST_TIMEOUT_MS) {
  return client.callTool({ name, arguments: args }, undefined, { timeout });
}

async function main() {
  const runConfig = parseArgs(process.argv);
  const workspace = runConfig.workspace;
  const stressDir = path.join(workspace, 'stress-temp-primary');

  if (runConfig.prepareWorkspace) {
    await ensureWorkspace(workspace);
  } else {
    await fs.mkdir(workspace, { recursive: true });
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--expose-gc', path.join(repoRoot, 'index.js'), '--workspace', workspace],
    cwd: repoRoot,
    stderr: 'pipe',
  });

  if (transport.stderr) {
    transport.stderr.on('data', (chunk) => {
      const text = String(chunk || '');
      if (!text.trim()) return;
      process.stderr.write(text);
    });
  }

  const client = new Client(
    { name: 'stress-primary-client', version: '1.0.0' },
    { capabilities: {} }
  );

  let closed = false;
  try {
    await client.connect(transport);
    console.log(`[stress] connected pid=${transport.pid ?? 'unknown'}`);
    console.log(
      `[stress] workspace=${workspace} initialForce=${runConfig.initialForce} rounds=${runConfig.rounds} filesPerRound=${runConfig.filesPerRound}`
    );

    const indexStart = Date.now();
    const indexResponse = await callTool(client, 'b_index_codebase', {
      force: runConfig.initialForce,
    });
    const indexText = getText(indexResponse);
    console.log(`[stress] initial index done in ${Date.now() - indexStart}ms`);
    console.log(indexText.split('\n').slice(0, 4).join('\n'));

    for (let round = 1; round <= runConfig.rounds; round += 1) {
      console.log(`[stress] round=${round} churn start`);
      await churnFiles(stressDir, round, runConfig.filesPerRound);

      console.log(`[stress] round=${round} index+search parallel start`);
      const uniqueToken = `STRESS_TOKEN_ROUND_${round}_FILE_7`;
      const queries = [
        `embed query process timeout round ${round}`,
        `persistent child process round ${round}`,
        uniqueToken,
      ];

      const tasks = [
        callTool(client, 'b_index_codebase', { force: false }),
        ...queries.map((query) => callTool(client, 'a_semantic_search', { query, maxResults: 3 })),
      ];
      const results = await Promise.all(tasks);

      const indexTextRound = getText(results[0] ?? {});
      const tokenSearchText = getText(results[3] ?? {});
      const foundToken = tokenSearchText.includes(uniqueToken);
      console.log(
        `[stress] round=${round} index result ok=${!indexTextRound.toLowerCase().startsWith('error:')}`
      );
      console.log(`[stress] round=${round} token searchable=${foundToken}`);

      console.log(`[stress] round=${round} idle wait 3500ms`);
      await sleep(3500);

      const postIdle = await callTool(client, 'a_semantic_search', {
        query: `post idle round ${round} persistent child restart`,
        maxResults: 2,
      });
      const postIdleText = getText(postIdle);
      console.log(
        `[stress] round=${round} post-idle search ok=${!postIdleText.toLowerCase().startsWith('error:')}`
      );
    }

    console.log('[stress] completed without transport EOF/crash');
  } finally {
    if (!closed) {
      closed = true;
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error('[stress] failed:', err?.stack || err?.message || String(err));
  process.exit(1);
});
