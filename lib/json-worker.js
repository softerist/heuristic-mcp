import fs from 'fs/promises';
import { parentPort, workerData } from 'worker_threads';

async function loadJson() {
  try {
    const data = await fs.readFile(workerData.filePath, 'utf-8');
    const parsed = JSON.parse(data);
    parentPort?.postMessage({ ok: true, data: parsed });
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: error.message });
  }
}

void loadJson();
