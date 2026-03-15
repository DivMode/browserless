import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mode = process.env.TEST_ENV || "dev";

const resolveConfig = {
  alias: {
    "@browserless.io/browserless": path.resolve(__dirname, "src/exports.ts"),
  },
};

export default defineConfig({
  test: {
    bail: 1,
    reporters: ["default", "json"],
    outputFile: { json: "/tmp/vitest-results.json" },
    projects: [
      {
        resolve: resolveConfig,
        test: {
          bail: 1,
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
          globals: false,
          env: { DEBUG: "" },
          fakeTimers: {
            toFake: undefined,
          },
        },
      },
      {
        resolve: resolveConfig,
        test: {
          bail: 1,
          include: ["src/**/*.integration.test.ts"],
          globals: false,
          testTimeout: 60_000,
          maxConcurrency: 50,
          globalSetup: ["./vitest.integration.setup.ts"],
          reporters: ["verbose"],
          env: loadEnv(mode, __dirname, ""),
        },
      },
    ],
  },
  resolve: resolveConfig,
});
