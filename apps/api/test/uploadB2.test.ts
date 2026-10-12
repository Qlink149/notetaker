import { mkdtemp, rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetEnvCache } from '../src/config/env.js';
import { audioLink } from '../src/lib/audioLink.js';
import { probe } from '../src/services/audio/ffmpeg.js';
import { SpeakerModel } from '../src/models/index.js';
import {
  ACCESS_CODE,
  clearDb,
  fakeStorage,
  makeFixture,
  seedWorkspace,
  startDb,
  stopDb,
} from './helpers.js';

// The browser-to-private-storage path: sign, create the meeting from a b2:// address, and enrol a voice
// sample (private storage cannot cut a clip, so the route keeps the first 30 s itself).
let app: Express;
let token: string;
let dir: string;
let wsSlug: string;
const uploaded: { publicId: string; seconds: number }[] = [];
const voiceprintUrls: string[] = [];

beforeAll(async () => {
  await startDb();
  process.env.PUBLIC_API_URL = 'https://api.example.test';
  resetEnvCache();
  dir = await mkdtemp(join(tmpdir(), 'up-b2-'));
  const fixture = await makeFixture(dir); // 2 minutes
  const storage = await fakeStorage();
  const base = storage.uploadAudio;
  storage.trimsRemotely = false;
  storage.signUpload = async (folder) => ({
    provider: 'b2',
    method: 'PUT',
    uploadUrl: 'https://b2.example/put?sig=1',
    folder,
    publicId: `${folder}/original-abc`,
    url: `b2://${folder}/original-abc`,
  });
  storage.presignGet = async (key) => `https://b2.example/get/${key}`;
  storage.uploadAudio = async (path, publicId) => {
    uploaded.push({ publicId, seconds: (await probe(path)).durationSec });
    return base(path, publicId);
  };
  app = createApp({
    storage,
    geminiFiles: {
      upload: async () => ({ uri: 'u', name: 'n', mimeType: 'audio/flac', keyId: 'k' }),
      delete: async () => undefined,
    },
    createVoiceprint: async (url) => {
      voiceprintUrls.push(url);
      return 'vp-string';
    },
  });
  (globalThis as { __fixture?: string }).__fixture = fixture;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await stopDb();
});
beforeEach(async () => {
  await clearDb();
  uploaded.length = 0;
  voiceprintUrls.length = 0;
  const ws = await seedWorkspace();
  wsSlug = ws.slug;
  const res = await request(app).post('/api/v1/auth/login').send({ code: ACCESS_CODE });
  token = res.body.token as string;
});
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

describe('upload to private storage', () => {
  it('signs a PUT upload bound to a fresh meeting folder', async () => {
    const res = await auth(request(app).post('/api/v1/uploads/sign')).expect(200);
    expect(res.body).toMatchObject({
      provider: 'b2',
      method: 'PUT',
      uploadUrl: 'https://b2.example/put?sig=1',
    });
    expect(res.body.folder).toBe(`workspaces/${wsSlug}/meetings/${res.body.meetingId as string}`);
    expect(res.body.publicId.startsWith(`${res.body.folder as string}/`)).toBe(true);
  });

  it('creates a meeting from a b2:// address and shows a signed playback link', async () => {
    const sig = (await auth(request(app).post('/api/v1/uploads/sign'))).body;
    const created = await auth(request(app).post('/api/v1/meetings'))
      .send({
        meetingId: sig.meetingId,
        title: 'From B2',
        publicId: sig.publicId,
        url: sig.url,
        languages: ['hi'],
      })
      .expect(201);
    expect(created.body.meeting.audio.originalUrl).toBe(sig.url);
    expect(created.body.meeting.audio.playbackUrl).toBe(audioLink(sig.publicId));
  });

  it('refuses a key outside the meeting folder', async () => {
    const sig = (await auth(request(app).post('/api/v1/uploads/sign'))).body;
    await auth(request(app).post('/api/v1/meetings'))
      .send({
        meetingId: sig.meetingId,
        title: 'x',
        publicId: 'workspaces/other/meetings/zzz/original-1',
        url: 'b2://workspaces/other/meetings/zzz/original-1',
      })
      .expect(400);
  });

  it('enrols a voice sample: keeps 30 s, hands pyannote a short-lived link, plays through a signed link', async () => {
    const fixture = (globalThis as { __fixture?: string }).__fixture!;
    const res = await auth(request(app).post('/api/v1/speakers/enrol'))
      .field('name', 'Heet')
      .attach('audio', await readFile(fixture), 'sample.wav')
      .expect(201);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.seconds).toBeLessThanOrEqual(30.6); // the 2-minute sample was cut
    expect(uploaded[0]!.seconds).toBeGreaterThan(29);
    expect(voiceprintUrls).toEqual([`https://b2.example/get/${uploaded[0]!.publicId}`]);
    const person = await SpeakerModel.findOne({ name: 'Heet' }).lean();
    expect(person!.voiceprints[0]!.audioUrl).toBe(audioLink(uploaded[0]!.publicId));
    expect(res.body.speaker.name).toBe('Heet');
  });
});
