import { register } from '../features/register.js';

// Run the registration process
console.log('[PostInstall] Running Heuristic MCP registration...');
register().catch(err => {
    console.error('[PostInstall] Registration failed:', err.message);
    // Don't fail the install if registration fails, just warn
    process.exit(0);
});
