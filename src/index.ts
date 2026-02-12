import { Browserless, Logger } from '@browserless.io/browserless';

(async () => {
  const browserless = new Browserless();
  const logger = new Logger('index.js');
  browserless.start();

  process
    .on('unhandledRejection', async (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    })
    .once('uncaughtException', async (err, origin) => {
      console.error('Unhandled exception at:', origin, 'error:', err);
      // Hard deadline: if graceful shutdown hangs (e.g. browserManager waiting
      // on broken Chrome connections), force exit so Docker can restart us.
      const forceExit = setTimeout(() => {
        console.error('Graceful shutdown timed out after 5s, forcing exit');
        process.exit(1);
      }, 5_000);
      forceExit.unref();
      await browserless.stop();
      process.exit(1);
    })
    .once('SIGTERM', async () => {
      logger.info(`SIGTERM received, saving and closing down`);
      const forceExit = setTimeout(() => {
        console.error('Graceful shutdown timed out after 10s, forcing exit');
        process.exit(1);
      }, 10_000);
      forceExit.unref();
      await browserless.stop();
      process.exit(0);
    })
    .once('SIGINT', async () => {
      logger.info(`SIGINT received, saving and closing down`);
      await browserless.stop();
      process.exit(0);
    })
    .once('SIGHUP', async () => {
      logger.info(`SIGHUP received, saving and closing down`);
      await browserless.stop();
      process.exit(0);
    })
    .once('SIGUSR2', async () => {
      logger.info(`SIGUSR2 received, saving and closing down`);
      await browserless.stop();
      process.exit(0);
    })
    .once('exit', () => {
      logger.info(`Process is finished, exiting`);
      process.exit(0);
    });
})();
