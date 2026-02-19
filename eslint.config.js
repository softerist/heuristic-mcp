import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', '.vitest-coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    files: [
      'scripts/**/*.js',
      'test/**/*.js',
      'repro_*.js',
      'tool_reproduction.js',
      'tools/scripts/**/*.js',
      'debug-pids.js',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['test/**/*.js'],
    rules: {
      'no-unused-vars': 'off',
    },
  },
];
