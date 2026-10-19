import { env } from './config/env.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { startHealthThread } from './lib/healthServer.js';
import { logger } from './lib/logger.js';
import { defaultDeps } from './pipeline/context.js';
import { Runner } from './pipeline/runner.js';
import { stages } from './pipeline/stages/index.js';

// Render background worker entrypoint.
async function main(): Promise<void> {
  const cfg = env();
  await connectMongo(cfg.MONGODB_URI, cfg.MONGODB_DB);
  const runner = new Runner(defaultDeps(), stages, {
    ...(cfg.WORKER_ID ? { workerId: cfg.WORKER_ID } : {}),
    concurrency: cfg.WORKER_CONCURRENCY,
    transcribeConcurrency: cfg.WORKER_TRANSCRIBE_CONCURRENCY,
  });

  // On its own thread, so a long CPU-heavy step cannot make Render's health check time out.
  const health = cfg.WORKER_HTTP
    ? startHealthThread(cfg.PORT, {
        concurrency: cfg.WORKER_CONCURRENCY,
        transcribeConcurrency: cfg.WORKER_TRANSCRIBE_CONCURRENCY,
        service: process.env.SERVICE_NAME ?? 'worker',
      })
    : null;
  if (health) logger.info({ port: cfg.PORT }, 'worker health endpoint listening');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down worker');
    await runner.stop();
    await health?.close();
    await disconnectMongo();
    process.exit(0);
  };
  // Transient database/network errors must not take the worker down; jobs are resumable anyway.
  process.on('unhandledRejection', (err) =>
    logger.error({ err }, 'unhandled rejection (worker keeps running)'),
  );
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await runner.start();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'worker crashed');
  process.exit(1);
});
