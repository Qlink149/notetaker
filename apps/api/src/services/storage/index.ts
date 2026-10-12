import { env, requireEnv, MissingConfigError } from '../../config/env.js';
import { createB2Storage } from './b2.js';
import { cloudinaryStorage, type StorageService } from './cloudinary.js';

let chosen: StorageService | null = null;

/**
 * The storage the app writes to: Cloudinary (default) or Backblaze B2 (STORAGE_PROVIDER=b2). With B2,
 * meetings made earlier on Cloudinary still download and delete through Cloudinary.
 */
export function getStorage(): StorageService {
  if (chosen) return chosen;
  if (env().STORAGE_PROVIDER === 'b2') {
    for (const k of ['B2_BUCKET', 'B2_KEY_ID', 'B2_APPLICATION_KEY', 'B2_ENDPOINT'] as const) {
      if (!env()[k]) throw new MissingConfigError(`${k} is not set (STORAGE_PROVIDER=b2)`);
    }
    chosen = createB2Storage({
      bucket: requireEnv('B2_BUCKET'),
      endpoint: requireEnv('B2_ENDPOINT'),
      ...(env().B2_REGION ? { region: env().B2_REGION as string } : {}),
      keyId: requireEnv('B2_KEY_ID'),
      applicationKey: requireEnv('B2_APPLICATION_KEY'),
      legacy: cloudinaryStorage,
    });
  } else chosen = cloudinaryStorage;
  return chosen;
}

/** For tests. */
export function resetStorageForTest(): void {
  chosen = null;
}
