import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mode = process.env.TEST_ENV || 'dev';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
          globals: false,
          fakeTimers: {
            toFake: undefined,
          },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          globals: false,
          testTimeout: 60_000,
          maxConcurrency: 50,
          globalSetup: ['./vitest.integration.setup.ts'],
          reporters: ['verbose'],
          env: loadEnv(mode, __dirname, ''),
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@browserless.io/browserless': path.resolve(__dirname, 'src/exports.ts'),
    },
  },
});
