import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: false,
    fakeTimers: {
      toFake: undefined,
    },
  },
  resolve: {
    alias: {
      '@browserless.io/browserless': path.resolve(__dirname, 'src/exports.ts'),
    },
  },
});
