import { register } from '../features/register.js';

// Run the registration process - MUST await to ensure file writes complete
console.info('[PostInstall] Running Heuristic MCP registration...');

try {
  await register();
  console.info('[PostInstall] Registration complete.');
} catch (err) {
  console.error('[PostInstall] Registration failed:', err.message);
  // Don't fail the install if registration fails, just warn
}
