import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    globals: false,
    testTimeout: 60_000,
    maxConcurrency: 50,
    globalSetup: ['./vitest.integration.setup.ts'],
    reporters: ['verbose'],
    env: loadEnv('dev', process.cwd(), ''),
  },
  resolve: {
    alias: {
      '@browserless.io/browserless': path.resolve(__dirname, 'src/exports.ts'),
    },
  },
});
