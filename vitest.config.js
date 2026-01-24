import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files pattern
    include: ['test/**/*.test.js'],

    // Global test timeout (embedding models can be slow)
    testTimeout: 180000,

    // Hook timeout for setup/teardown
    hookTimeout: 180000,

    // Run test files sequentially to avoid resource conflicts
    // Each file loads the embedding model which uses significant memory
    fileParallelism: false,

    // Run tests within a file sequentially
    sequence: {
      concurrent: false,
    },

    // Verbose output
    reporters: ['verbose'],

    // Isolate tests to prevent memory leaks between test files
    isolate: true,

    coverage: {
      provider: 'v8',
      all: true,
      include: ['features/**/*.js', 'lib/**/*.js', 'index.js'],
      exclude: ['**/test/**'],
      reporter: ['text', 'html', 'json'],
      reportsDirectory: '.vitest-coverage',
      clean: true,
    },
  },
});
