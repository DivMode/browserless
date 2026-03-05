import { Browserless, Logger } from '@browserless.io/browserless';
import { Effect } from 'effect';

// ── Fail-fast env validation ─────────────────────────────────────────
// REQUIRED env vars must be present BEFORE the server accepts connections.
// Without this, a stale `node --watch` process (started without proper env)
// silently boots and steals connections — all replays fail with no error.
// See: 2026-03-04 incident — 2 hours debugging phantom replay failures
// caused by a zombie `node --watch` process with empty env.
const REQUIRED_ENV = ['REPLAY_INGEST_URL'] as const;
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`\n  FATAL: Missing required env var: ${key}`);
    console.error(`  Set it in .env.dev (local) or production config.\n`);
    process.exit(1);
  }
}

(async () => {
  const browserless = new Browserless();
  const logger = new Logger('index.js');
  browserless.start();

  const shutdown = (_reason: string, code: number) =>
    Effect.runPromise(
      Effect.tryPromise(() => browserless.stop()).pipe(
        Effect.timeout('10 seconds'),
        Effect.catch(() => Effect.void),
      ),
    ).finally(() => process.exit(code));

  process
    .once('SIGTERM', () => {
      logger.info('SIGTERM received, saving and closing down');
      shutdown('SIGTERM', 0);
    })
    .once('SIGINT', () => {
      logger.info('SIGINT received, saving and closing down');
      shutdown('SIGINT', 0);
    })
    .once('SIGHUP', () => {
      logger.info('SIGHUP received, saving and closing down');
      shutdown('SIGHUP', 0);
    })
    .once('SIGUSR2', () => {
      logger.info('SIGUSR2 received, saving and closing down');
      shutdown('SIGUSR2', 0);
    })
    .once('uncaughtException', (err, origin) => {
      console.error('Unhandled exception at:', origin, 'error:', err);
      shutdown('uncaughtException', 1);
    })
    .on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });
})();
