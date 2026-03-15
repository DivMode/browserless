import Pyroscope from "@pyroscope/nodejs";
import { Browserless } from "@browserless.io/browserless";
import { Effect } from "effect";

// ── Continuous profiling (Pyroscope) ─────────────────────────────────
// Must init before any other code to capture full startup profile.
// Gracefully skips when PYROSCOPE_SERVER_ADDRESS is unset (local dev).
if (process.env.PYROSCOPE_SERVER_ADDRESS) {
  Pyroscope.init({
    serverAddress: process.env.PYROSCOPE_SERVER_ADDRESS,
    appName: process.env.OTEL_SERVICE_NAME ?? "browserless",
    basicAuthUser: process.env.PYROSCOPE_BASIC_AUTH_USER ?? "",
    basicAuthPassword: process.env.PYROSCOPE_BASIC_AUTH_PASSWORD ?? "",
    wall: { collectCpuTime: true },
    tags: {
      env: process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? "production",
      server: "flatcar",
    },
  });
  Pyroscope.start();
}

// ── Fail-fast env validation ─────────────────────────────────────────
// REQUIRED env vars must be present BEFORE the server accepts connections.
// Without this, a stale `node --watch` process (started without proper env)
// silently boots and steals connections — all replays fail with no error.
// See: 2026-03-04 incident — 2 hours debugging phantom replay failures
// caused by a zombie `node --watch` process with empty env.
const REQUIRED_ENV = ["REPLAY_INGEST_URL"] as const;
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`\n  FATAL: Missing required env var: ${key}`);
    console.error(`  Set it in .env.dev (local) or production config.\n`);
    process.exit(1);
  }
}

const program = Effect.fn("browserless.main")(function* () {
  const browserless = new Browserless();

  yield* Effect.promise(() => browserless.start());

  const shutdown = (_reason: string, code: number) =>
    Effect.runPromise(
      Effect.tryPromise(() => browserless.stop()).pipe(
        // 25s — enough for session cleanup (replay flush + browser close) + OTLP export.
        // Docker stop_timeout must be > this (set to 30s in infra config).
        // Previous 10s timeout killed the process during replay flush, losing root spans.
        Effect.timeout("25 seconds"),
        Effect.catch(() => Effect.void),
      ),
    ).finally(() => process.exit(code));

  process
    .once("SIGTERM", () => {
      console.error(
        JSON.stringify({ message: "SIGTERM received, saving and closing down", level: "info" }),
      );
      shutdown("SIGTERM", 0);
    })
    .once("SIGINT", () => {
      console.error(
        JSON.stringify({ message: "SIGINT received, saving and closing down", level: "info" }),
      );
      shutdown("SIGINT", 0);
    })
    .once("SIGHUP", () => {
      console.error(
        JSON.stringify({ message: "SIGHUP received, saving and closing down", level: "info" }),
      );
      shutdown("SIGHUP", 0);
    })
    .once("SIGUSR2", () => {
      console.error(
        JSON.stringify({ message: "SIGUSR2 received, saving and closing down", level: "info" }),
      );
      shutdown("SIGUSR2", 0);
    })
    .once("uncaughtException", (err, origin) => {
      console.error("Unhandled exception at:", origin, "error:", err);
      shutdown("uncaughtException", 1);
    })
    .on("unhandledRejection", (reason, promise) => {
      console.error("Unhandled Rejection at:", promise, "reason:", reason);
    });

  // Keep the process alive — the HTTP server listener keeps the event loop running.
  // This yield* never completes — shutdown happens via signal handlers.
  yield* Effect.never;
})();

Effect.runFork(program);
