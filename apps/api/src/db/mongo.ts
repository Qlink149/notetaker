import mongoose from 'mongoose';
import { logger } from '../lib/logger.js';
import { allModels } from '../models/index.js';

mongoose.set('strictQuery', true);

export async function connectMongo(uri: string): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });
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
