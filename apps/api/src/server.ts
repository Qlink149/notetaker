import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { logger } from './lib/logger.js';
import { deleteGeminiFile, uploadToGeminiFiles } from './services/engines/gemini.js';
import { createVoiceprint } from './services/pyannote/client.js';
import { cloudinaryStorage } from './services/storage/cloudinary.js';

// Render web service entrypoint. Long work never runs here; it is queued for the worker.
async function main(): Promise<void> {
  const cfg = env();
  await connectMongo(cfg.MONGODB_URI);
  const app = createApp({
    storage: cloudinaryStorage,
    geminiFiles: { upload: uploadToGeminiFiles, delete: deleteGeminiFile },
    createVoiceprint,
  });
  const server = app.listen(cfg.PORT, () => logger.info({ port: cfg.PORT }, 'api listening'));
  const shutdown = (): void => {
    server.close(() => void disconnectMongo().then(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'api crashed');
  process.exit(1);
});
