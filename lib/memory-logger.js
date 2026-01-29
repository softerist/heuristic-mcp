function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function logMemory(prefix) {
  const { rss, heapUsed, heapTotal } = process.memoryUsage();
  console.info(`${prefix} rss=${formatMb(rss)} heap=${formatMb(heapUsed)}/${formatMb(heapTotal)}`);
}

export function startMemoryLogger(prefix, intervalMs) {
  const timer = setInterval(() => logMemory(prefix), intervalMs);
  return () => clearInterval(timer);
}
