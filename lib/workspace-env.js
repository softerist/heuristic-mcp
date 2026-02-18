import {
  DYNAMIC_WORKSPACE_ENV_PREFIX,
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

export function getDynamicWorkspaceEnvKeys(env = process.env) {
  return Object.keys(env)
    .filter((key) => key.startsWith(DYNAMIC_WORKSPACE_ENV_PREFIX))
    .filter((key) => WORKSPACE_ENV_KEY_PATTERN.test(key))
    .filter((key) => !WORKSPACE_ENV_VARS.includes(key))
    .sort((a, b) => scoreWorkspaceEnvKey(b) - scoreWorkspaceEnvKey(a));
}

export function getWorkspaceEnvKeys(env = process.env) {
  return [...WORKSPACE_ENV_VARS, ...getDynamicWorkspaceEnvKeys(env)];
}
