import type { GeminiFiles } from '../pipeline/context.js';
import type { StorageService } from '../services/storage/cloudinary.js';

/** External services the HTTP API touches. Tests pass fakes. */
export interface ApiDeps {
  storage: StorageService;
  geminiFiles: GeminiFiles;
  createVoiceprint: (url: string) => Promise<string>;
}
