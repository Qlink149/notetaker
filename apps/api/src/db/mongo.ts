import mongoose from 'mongoose';
import { logger } from '../lib/logger.js';
import { allModels } from '../models/index.js';

mongoose.set('strictQuery', true);

/** Connect; `dbName` applies only when the URI has no database in its path. */
export async function connectMongo(uri: string, dbName?: string): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  const uriHasDb = /^mongodb(\+srv)?:\/\/[^/]+\/[^?/]+/.test(uri);
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15_000,
    // A reply lost on the network must fail, not wait forever: on 19 Oct an assembly sat idle for 20+ minutes
    // (CPU 0.3%) holding the only heavy lane, with "200 planning" queued behind it. 2 minutes is far above
    // any real operation (the largest meeting document is ~2 MB); the job is then retried.
    socketTimeoutMS: 120_000,
    ...(uriHasDb || !dbName ? {} : { dbName }),
  });
  await ensureIndexes();
  logger.info({ db: mongoose.connection.name }, 'mongo connected');
  return mongoose;
}

/** Create every declared index (Job(status, runAfter), Meeting(workspaceId, createdAt), …). */
export async function ensureIndexes(): Promise<void> {
  await Promise.all(allModels.map((m) => m.createIndexes()));
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}

export function mongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}
