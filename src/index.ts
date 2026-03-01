import { Browserless, Logger } from '@browserless.io/browserless';
import { Effect } from 'effect';

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
