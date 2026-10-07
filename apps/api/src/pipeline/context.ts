import type { Logger } from 'pino';
import type { JobStage } from '@meetingid/shared';
import { AnonymousResolver, type SpeakerResolver } from '@meetingid/pipeline';
import type { JobDoc } from '../models/index.js';
import * as ffmpeg from '../services/audio/ffmpeg.js';
import { createEngine, type EngineFactory } from '../services/engines/index.js';
import {
  deleteGeminiFile,
  uploadToGeminiFiles,
  type UploadedFile,
} from '../services/engines/gemini.js';
import { cloudinaryStorage, type StorageService } from '../services/storage/cloudinary.js';
import { ClaudeSummariser, type Summariser } from '../services/summary/claude.js';

export interface AudioTools {
  probe: typeof ffmpeg.probe;
  toAnalysisFlac: typeof ffmpeg.toAnalysisFlac;
  decodedDuration: typeof ffmpeg.decodedDuration;
  detectSilences: typeof ffmpeg.detectSilences;
  noiseFloorDb: typeof ffmpeg.noiseFloorDb;
  cutFlac: typeof ffmpeg.cutFlac;
}

export interface GeminiFiles {
  upload(path: string, mimeType: string, displayName: string): Promise<UploadedFile>;
  delete(name: string, keyId?: string | null): Promise<void>;
}

/** Everything a stage touches outside MongoDB. Tests swap in fakes. */
export interface Deps {
  storage: StorageService;
  engine: EngineFactory;
  summariser: Summariser;
  geminiFiles: GeminiFiles;
  resolver: SpeakerResolver;
  audio: AudioTools;
  now: () => Date;
}

export function defaultDeps(): Deps {
  return {
    storage: cloudinaryStorage,
    engine: createEngine,
    summariser: new ClaudeSummariser(),
    geminiFiles: { upload: uploadToGeminiFiles, delete: deleteGeminiFile },
    resolver: new AnonymousResolver(),
    audio: {
      probe: ffmpeg.probe,
      toAnalysisFlac: ffmpeg.toAnalysisFlac,
      decodedDuration: ffmpeg.decodedDuration,
      detectSilences: ffmpeg.detectSilences,
      noiseFloorDb: ffmpeg.noiseFloorDb,
      cutFlac: ffmpeg.cutFlac,
    },
    now: () => new Date(),
  };
}

export interface StageContext {
  job: JobDoc;
  log: Logger;
  deps: Deps;
  /** Fresh per-job temp directory, removed after the job whatever happens. */
  tmpDir: string;
}

export interface StageHandler {
  run(ctx: StageContext): Promise<void>;
  /** Called once retries are exhausted (or on a FatalError) instead of the default meeting failure. */
  onGiveUp?(ctx: StageContext, error: Error): Promise<void>;
}

export type StageRegistry = Record<JobStage, StageHandler>;
