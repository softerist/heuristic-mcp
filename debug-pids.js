import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

async function check() {
  console.log('Checking processes...');
  try {
    const { stdout } = await execPromise(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' } | Select-Object ProcessId, CommandLine, ParentProcessId | ConvertTo-Json"`
    );
    const processes = JSON.parse(stdout);
    const list = Array.isArray(processes) ? processes : [processes];
    
    for (const p of list) {
      if (p.CommandLine && (p.CommandLine.includes('heuristic-mcp') || p.CommandLine.includes('index.js'))) {
        console.log(`PID: ${p.ProcessId}, Parent: ${p.ParentProcessId}`);
        console.log(`CMD: ${p.CommandLine}`);
        console.log('---');
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

check();
