import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';
import {
  createVoiceprint,
  getJob,
  keyLabelFor,
  submitDiarize,
  submitVoiceprint,
  uploadMedia,
} from '../src/services/pyannote/client.js';

// Voiceprints may live on a second pyannote account: their requests, their clip upload and their job
// polling must use that account's key (a job and its media belong to the account that made them),
// and everything else must keep using the main key.
const MAIN = 'key-main-0000';
const VOICE = 'key-voiceprint-1111';

interface Seen {
  url: string;
  auth: string | null;
}
let seen: Seen[] = [];

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url: String(url), auth: headers.Authorization ?? null });
      const u = String(url);
      if (u.includes('/media/input'))
        return new Response(JSON.stringify({ url: 'https://upload.example/put' }), { status: 200 });
      if (u.startsWith('https://upload.example')) return new Response('', { status: 200 });
      if (u.includes('/jobs/'))
        return new Response(
          JSON.stringify({ jobId: 'job1', status: 'succeeded', output: { voiceprint: 'VP' } }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ jobId: 'job1' }), { status: 200 });
    }),
  );
}

function setEnv(voiceprintKey?: string): void {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://localhost:27017/unused',
    JWT_SECRET: 'x'.repeat(40),
    GEMINI_API_KEY: 'test-gemini',
    PYANNOTEAI_API_KEY: MAIN,
  });
  if (voiceprintKey) process.env.PYANNOTEAI_VOICEPRINT_API_KEY = voiceprintKey;
  else delete process.env.PYANNOTEAI_VOICEPRINT_API_KEY;
  resetEnvCache();
}

beforeEach(() => {
  seen = [];
  stubFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PYANNOTEAI_VOICEPRINT_API_KEY;
  resetEnvCache();
});

const bearer = (k: string): string => `Bearer ${k}`;
const forPath = (part: string): Seen => seen.find((s) => s.url.includes(part))!;

describe('pyannote accounts', () => {
  it('with a voiceprint key: voiceprint calls use it, diarization keeps the main key', async () => {
    setEnv(VOICE);
    await submitVoiceprint('media://clip', 'precision-2');
    await submitDiarize('media://meeting', { model: 'precision-2' });
    await getJob('job1', 'voiceprint');
    await getJob('job2');
    expect(seen[0]).toMatchObject({ url: expect.stringContaining('/voiceprint') as string });
    expect(seen[0]!.auth).toBe(bearer(VOICE));
    expect(forPath('/diarize').auth).toBe(bearer(MAIN));
    expect(seen.find((s) => s.url.endsWith('/jobs/job1'))!.auth).toBe(bearer(VOICE));
    expect(seen.find((s) => s.url.endsWith('/jobs/job2'))!.auth).toBe(bearer(MAIN));
    expect(keyLabelFor('voiceprint')).toBe('PYANNOTEAI_VOICEPRINT_API_KEY');
    expect(keyLabelFor('main')).toBe('PYANNOTEAI_API_KEY');
  });

  it('a clip is uploaded to, and its voiceprint job polled on, the voiceprint account', async () => {
    setEnv(VOICE);
    const dir = await mkdtemp(join(tmpdir(), 'pya-'));
    try {
      const file = join(dir, 'clip.flac');
      await writeFile(file, 'audio');
      await uploadMedia(file, 'clip-1.flac', 'voiceprint');
      const vp = await createVoiceprint('media://clip-1.flac');
      expect(vp).toBe('VP');
      const pyannoteCalls = seen.filter((s) => s.url.startsWith('https://api.pyannote.ai'));
      expect(pyannoteCalls.length).toBeGreaterThanOrEqual(3); // media/input, voiceprint, jobs
      expect(pyannoteCalls.every((s) => s.auth === bearer(VOICE))).toBe(true);
      // the presigned upload URL never receives the API key
      expect(seen.find((s) => s.url.startsWith('https://upload.example'))!.auth).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('without a voiceprint key everything uses the main key', async () => {
    setEnv();
    await submitVoiceprint('media://clip', 'precision-2');
    await getJob('job1', 'voiceprint');
    expect(seen.every((s) => s.auth === bearer(MAIN))).toBe(true);
    expect(keyLabelFor('voiceprint')).toBe('PYANNOTEAI_API_KEY');
  });
});
