import fs from 'fs/promises';
import path from 'path';

export function getLogFilePath(config) {
  return path.join(config.cacheDirectory, 'logs', 'server.log');
}

export async function ensureLogDirectory(config) {
  const logPath = getLogFilePath(config);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  return logPath;
}
