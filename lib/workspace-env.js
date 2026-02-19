import {
  DYNAMIC_WORKSPACE_ENV_PREFIXES,
  WORKSPACE_ENV_GENERIC_DISCOVERY_PATTERN,
  WORKSPACE_ENV_KEY_PATTERN,
  WORKSPACE_ENV_VARS,
} from './constants.js';

export function scoreWorkspaceEnvKey(key) {
  const upper = String(key || '').toUpperCase();
  let score = 0;
  if (upper.includes('WORKSPACE')) score += 8;
  if (upper.includes('PROJECT')) score += 4;
  if (upper.includes('ROOT')) score += 3;
  if (upper.includes('CWD')) score += 2;
  if (upper.includes('DIR')) score += 1;
  return score;
}

function hasDynamicWorkspacePrefix(key) {
  return DYNAMIC_WORKSPACE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function getDynamicWorkspaceEnvKeys(env = process.env) {
  return Object.keys(env)
    .filter((key) => !WORKSPACE_ENV_VARS.includes(key))
    .filter((key) => {
      const providerSpecific = hasDynamicWorkspacePrefix(key) && WORKSPACE_ENV_KEY_PATTERN.test(key);
      const genericWorkspace = WORKSPACE_ENV_GENERIC_DISCOVERY_PATTERN.test(key);
      return providerSpecific || genericWorkspace;
    })
    .sort((a, b) => scoreWorkspaceEnvKey(b) - scoreWorkspaceEnvKey(a));
}

export function getWorkspaceEnvKeys(env = process.env) {
  return [...WORKSPACE_ENV_VARS, ...getDynamicWorkspaceEnvKeys(env)];
}

/**
 * Diagnostic view of workspace-related env keys.
 * Includes fallback keys that are not used for automatic resolution so startup logs
 * can show what the IDE actually passed to the MCP process.
 */
export function getWorkspaceEnvDiagnosticKeys(env = process.env) {
  const prioritized = getWorkspaceEnvKeys(env);
  const prioritizedSet = new Set(prioritized);

  const extraKeys = Object.keys(env)
    .filter((key) => !prioritizedSet.has(key))
    .filter((key) => WORKSPACE_ENV_KEY_PATTERN.test(key))
    .sort((a, b) => scoreWorkspaceEnvKey(b) - scoreWorkspaceEnvKey(a));

  return [...prioritized, ...extraKeys];
}
