import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    globals: false,
    testTimeout: 60_000,
    globalSetup: ['./vitest.integration.setup.ts'],
    reporters: ['verbose'],
  },
  resolve: {
    alias: {
      '@browserless.io/browserless': path.resolve(__dirname, 'src/exports.ts'),
    },
  },
});
