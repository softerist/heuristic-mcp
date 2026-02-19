import { describe, expect, it } from 'vitest';
import {
  getDynamicWorkspaceEnvKeys,
  getWorkspaceEnvDiagnosticKeys,
  getWorkspaceEnvKeys,
  scoreWorkspaceEnvKey,
} from '../lib/workspace-env.js';

describe('workspace-env', () => {
  it('scores workspace-like keys higher than generic keys', () => {
    expect(scoreWorkspaceEnvKey('FOO_WORKSPACE')).toBeGreaterThan(scoreWorkspaceEnvKey('FOO_ROOT'));
    expect(scoreWorkspaceEnvKey('FOO_ROOT')).toBeGreaterThan(scoreWorkspaceEnvKey('FOO_DIR'));
  });

  it('discovers provider-specific dynamic keys via known prefixes', () => {
    const env = {
      HEURISTIC_MCP_ENABLE_DYNAMIC_WORKSPACE_ENV: 'true',
      ANTIGRAVITY_PROJECT_ROOT: 'F:\\Git\\heuristic-mcp',
      FOO_PROJECT_ROOT: 'F:\\Other\\project',
    };

    const keys = getDynamicWorkspaceEnvKeys(env);
    expect(keys).toContain('ANTIGRAVITY_PROJECT_ROOT');
    expect(keys).not.toContain('FOO_PROJECT_ROOT');
  });

  it('discovers unknown generic keys containing WORKSPACE', () => {
    const env = {
      HEURISTIC_MCP_ENABLE_DYNAMIC_WORKSPACE_ENV: 'true',
      SOME_NEW_IDE_WORKSPACE_PATH: 'F:\\Git\\heuristic-mcp',
      SOME_NEW_IDE_PROJECT_ROOT: 'F:\\Git\\heuristic-mcp',
    };

    const keys = getDynamicWorkspaceEnvKeys(env);
    expect(keys).toContain('SOME_NEW_IDE_WORKSPACE_PATH');
    expect(keys).not.toContain('SOME_NEW_IDE_PROJECT_ROOT');
  });

  it('returns diagnostic keys including non-priority workspace-like keys', () => {
    const env = {
      RANDOM_PROJECT_ROOT: 'F:\\Git\\heuristic-mcp',
      ANOTHER_DIR: 'F:\\Git',
    };

    const diagnosticKeys = getWorkspaceEnvDiagnosticKeys(env);
    expect(diagnosticKeys).toContain('RANDOM_PROJECT_ROOT');
    expect(diagnosticKeys).toContain('ANOTHER_DIR');
  });

  it('keeps static workspace keys at the front of resolution order', () => {
    const env = {
      HEURISTIC_MCP_ENABLE_DYNAMIC_WORKSPACE_ENV: 'true',
      SOME_NEW_IDE_WORKSPACE_PATH: 'F:\\Git\\heuristic-mcp',
    };

    const keys = getWorkspaceEnvKeys(env);
    expect(keys[0]).toBe('HEURISTIC_MCP_WORKSPACE');
    expect(keys).toContain('SOME_NEW_IDE_WORKSPACE_PATH');
  });

  it('disables dynamic workspace env discovery by default', () => {
    const env = {
      SOME_NEW_IDE_WORKSPACE_PATH: 'c:\\heuristic-mcp',
      ANTIGRAVITY_PROJECT_ROOT: 'c:\\heuristic-mcp',
    };

    expect(getDynamicWorkspaceEnvKeys(env)).toEqual([]);
    expect(getWorkspaceEnvKeys(env)).not.toContain('SOME_NEW_IDE_WORKSPACE_PATH');
    expect(getWorkspaceEnvKeys(env)).not.toContain('ANTIGRAVITY_PROJECT_ROOT');
  });

  it('excludes known bad dynamic keys even when dynamic discovery is enabled', () => {
    const env = {
      HEURISTIC_MCP_ENABLE_DYNAMIC_WORKSPACE_ENV: 'true',
      ANTIGRAVITY_EDITOR_APP_ROOT:
        'C:\\Users\\user\\AppData\\Local\\Programs\\Antigravity\\resources\\app',
      ANTIGRAVITY_WORKSPACE_ROOT: 'C:\\heuristic-mcp',
    };

    const keys = getDynamicWorkspaceEnvKeys(env);
    expect(keys).toContain('ANTIGRAVITY_WORKSPACE_ROOT');
    expect(keys).not.toContain('ANTIGRAVITY_EDITOR_APP_ROOT');
  });
});
