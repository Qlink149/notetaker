import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { logger } from './lib/logger.js';
import { defaultDeps } from './pipeline/context.js';
import { Runner } from './pipeline/runner.js';
import { stages } from './pipeline/stages/index.js';
import { deleteGeminiFile, uploadToGeminiFiles } from './services/engines/gemini.js';
import { createVoiceprint } from './services/pyannote/client.js';
import { cloudinaryStorage } from './services/storage/cloudinary.js';

// API and worker in one process, for a single Render Free web service (Render has no free
// background workers). Keep it awake with an uptime ping on /api/v1/health every ≤10 minutes;
// a Free service sleeps after 15 minutes without inbound traffic. Jobs are resumable, so a
// restart or sleep only delays work. Switch to server.ts + worker.ts when the worker gets its
// own (paid) instance — no other change needed.
async function main(): Promise<void> {
  const cfg = env();
  await connectMongo(cfg.MONGODB_URI, cfg.MONGODB_DB);
  const app = createApp({
    storage: cloudinaryStorage,
    geminiFiles: { upload: uploadToGeminiFiles, delete: deleteGeminiFile },
    createVoiceprint,
  });
  const server = app.listen(cfg.PORT, () =>
    logger.info({ port: cfg.PORT }, 'api listening (combined mode)'),
  );
  const runner = new Runner(defaultDeps(), stages, {
    ...(cfg.WORKER_ID ? { workerId: cfg.WORKER_ID } : {}),
    concurrency: cfg.WORKER_CONCURRENCY,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    server.close();
    await runner.stop();
    await disconnectMongo();
    process.exit(0);
  };
  process.on('unhandledRejection', (err) =>
    logger.error({ err }, 'unhandled rejection (process keeps running)'),
  );
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  await runner.start();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'crashed');
  process.exit(1);
});
