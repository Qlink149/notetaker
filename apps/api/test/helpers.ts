import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import type { RawTurn } from '@meetingid/pipeline';
import { AnonymousResolver } from '@meetingid/pipeline';
import { resetEnvCache } from '../src/config/env.js';
import { ensureIndexes } from '../src/db/mongo.js';
import { hashAccessCode } from '../src/lib/auth.js';
import { GlossaryModel, WorkspaceModel, type WorkspaceDoc } from '../src/models/index.js';
import type { Deps } from '../src/pipeline/context.js';
import * as ffmpeg from '../src/services/audio/ffmpeg.js';
import type {
  ChunkInput,
  ChunkResult,
  TranscriptionEngine,
} from '../src/services/engines/types.js';
import type { StorageService } from '../src/services/storage/cloudinary.js';
import type { Summariser } from '../src/services/summary/claude.js';

export const ACCESS_CODE = 'test-access-code-123';

let mongo: MongoMemoryServer | null = null;

export async function startDb(): Promise<void> {
  mongo = await MongoMemoryServer.create();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGODB_URI: mongo.getUri(),
    JWT_SECRET: 'x'.repeat(40),
    CORS_ORIGINS: 'https://meetingid.example',
    GEMINI_API_KEY: 'test-gemini',
    DEEPGRAM_API_KEY: 'test-deepgram',
    PYANNOTEAI_API_KEY: 'test-pyannote',
  });
  resetEnvCache();
  await mongoose.connect(mongo.getUri());
  await ensureIndexes();
}

export async function stopDb(): Promise<void> {
  await mongoose.disconnect();
  await mongo?.stop();
}

export async function clearDb(): Promise<void> {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

export async function seedWorkspace(): Promise<WorkspaceDoc> {
  const w = await WorkspaceModel.create({
    name: 'Kisna',
    slug: 'kisna',
    accessCodeHash: hashAccessCode(ACCESS_CODE),
    settings: {
      engine: 'gemini',
      languages: ['hi', 'gu', 'en'],
      scriptPreference: 'roman',
      summaryModel: 'test-model',
    },
  });
  await GlossaryModel.create({
    workspaceId: w._id,
    entries: [{ term: 'Kisna', kind: 'company', aliases: [] }],
  });
  return w.toObject() as WorkspaceDoc;
}

/** Local-disk stand-in for Cloudinary: URLs are file paths. */
export async function fakeStorage(): Promise<StorageService & { root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'fake-cld-'));
  const put = async (path: string, publicId: string) => {
    const dest = join(root, publicId.replace(/[\\/]/g, '__'));
    await mkdir(root, { recursive: true });
    await copyFile(path, dest);
    return { url: dest, publicId };
  };
  return {
    root,
    signUpload: (folder) => ({
      cloudName: 'test',
      apiKey: 'k',
      folder,
      timestamp: 1,
      signature: 'sig',
      uploadUrl: 'https://upload.example',
    }),
    uploadAudio: put,
    trimmedWavUrl: (id, s, e) => `wav://${id}/${s}-${e}`,
    playbackUrl: (id) => `mp3://${id}`,
    download: async (url, dest) => copyFile(url, dest),
    deleteFolder: async () => undefined,
  };
}

/** Generate a 2-minute fixture: 50 s tone, 10 s silence, 60 s tone (tone = "speech" for silencedetect). */
export async function makeFixture(dir: string): Promise<string> {
  const out = join(dir, 'fixture.wav');
  const { spawnSync } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const bin = (createRequire(import.meta.url)('@ffmpeg-installer/ffmpeg') as { path: string }).path;
  const r = spawnSync(bin, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=50:sample_rate=16000',
    '-f',
    'lavfi',
    '-t',
    '10',
    '-i',
    'anullsrc=r=16000:cl=mono',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=550:duration=60:sample_rate=16000',
    '-filter_complex',
    '[0][1][2]concat=n=3:v=0:a=1',
    '-ac',
    '1',
    out,
  ]);
  if (r.status !== 0) throw new Error(`fixture generation failed: ${r.stderr.toString()}`);
  return out;
}

export interface FakeEngine extends TranscriptionEngine {
  calls: ChunkInput[];
}

/** Engine returning scripted turns for each call (chunk-relative times). */
export function fakeEngine(
  script: (input: ChunkInput, call: number) => ChunkResult | Error,
): FakeEngine {
  const calls: ChunkInput[] = [];
  return {
    name: 'gemini',
    accepts: ['gemini-file'],
    calls,
    async transcribeChunk(input) {
      calls.push(input);
      const r = script(input, calls.length);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

export function turnsCovering(from: number, to: number, step = 10): RawTurn[] {
  const out: RawTurn[] = [];
  for (let t = from, i = 0; t < to; t += step, i++) {
    out.push({
      speaker: i % 2 ? 'S2' : 'S1',
      start: t,
      end: Math.min(to, t + step - 0.5),
      text_native: `वाक्य नंबर ${i} Kisna`,
      text_roman: `vakya number ${i} Kisna ka plan ${i}`,
      lang: 'mixed',
    });
  }
  return out;
}

export const okResult = (turns: RawTurn[]): ChunkResult => ({
  turns,
  usage: { inputTokens: 1000, outputTokens: 200, audioSec: 0 },
  model: 'fake',
  finish: 'complete',
});

export const fakeSummariser = (): Summariser & { calls: number } => {
  const s = {
    calls: 0,
    async summarise() {
      s.calls++;
      return {
        result: {
          summaryMarkdown: '## Overview\nTest meeting.',
          actionItems: [{ speakerName: 'Speaker 1', text: 'Send the plan.' }],
        },
        usage: { inputTokens: 500, outputTokens: 100 },
      };
    },
  };
  return s;
};

export function testDeps(over: Partial<Deps> & Pick<Deps, 'storage' | 'engine'>): Deps {
  let fileId = 0;
  return {
    summariser: fakeSummariser(),
    geminiFiles: {
      upload: async () => {
        fileId++;
        return { uri: `gemini://file-${fileId}`, name: `files/${fileId}`, mimeType: 'audio/flac' };
      },
      delete: async () => undefined,
    },
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
    ...over,
  };
}
