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
