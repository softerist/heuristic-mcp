import { register } from '../features/register.js';

console.info('[PostInstall] Running Heuristic MCP registration...');

try {
  await register();
  console.info('[PostInstall] Registration complete.');
} catch (err) {
  console.error('[PostInstall] Registration failed:', err.message);
}
