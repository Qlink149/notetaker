import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { audioLink, audioLinkValid } from '../src/lib/audioLink.js';
import { MeetingModel, type WorkspaceDoc } from '../src/models/index.js';
import { ACCESS_CODE, clearDb, fakeStorage, seedWorkspace, startDb, stopDb } from './helpers.js';

// Audio on private storage is played through a signed link on our own API, which redirects to a
// short-lived storage link. The link cannot be forged, retargeted, or used without the secret.
let app: Express;
let workspace: WorkspaceDoc;
let token: string;
const presigned: string[] = [];

beforeAll(async () => {
  await startDb();
  process.env.PUBLIC_API_URL = 'https://api.example.test/';
  const { resetEnvCache } = await import('../src/config/env.js');
  resetEnvCache();
  const storage = await fakeStorage();
  storage.presignGet = async (key, seconds) => {
    presigned.push(`${key}|${seconds ?? 'default'}`);
    return `https://b2.example/${key}?signed=1`;
  };
  app = createApp({
    storage,
    geminiFiles: {
      upload: async () => ({ uri: 'u', name: 'n', mimeType: 'audio/flac', keyId: 'k' }),
      delete: async () => undefined,
    },
    createVoiceprint: async () => 'vp',
  });
});
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  presigned.length = 0;
  workspace = await seedWorkspace();
  const res = await request(app).post('/api/v1/auth/login').send({ code: ACCESS_CODE });
  token = res.body.token as string;
});

describe('signed audio links', () => {
  it('build an absolute link that validates only for its own key', () => {
    const link = audioLink('ws/a/original-1');
    expect(link.startsWith('https://api.example.test/api/v1/audio?k=')).toBe(true);
    const u = new URL(link);
    const t = u.searchParams.get('t')!;
    expect(audioLinkValid('ws/a/original-1', t)).toBe(true);
    expect(audioLinkValid('ws/a/original-2', t)).toBe(false); // another object
    expect(
      audioLinkValid(
        'ws/a/original-1',
        t.replace(/.$/, (c) => (c === '0' ? '1' : '0')),
      ),
    ).toBe(false);
    expect(audioLinkValid('ws/a/original-1', '')).toBe(false);
  });

  it('redirect (302) to a fresh storage link without any login', async () => {
    const u = new URL(audioLink('ws/a/original-1'));
    const res = await request(app).get(`/api/v1/audio${u.search}`).redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://b2.example/ws/a/original-1?signed=1');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(presigned).toEqual(['ws/a/original-1|default']);
  });

  it('refuse a forged token, a missing token, and a token for another key', async () => {
    const t = new URL(audioLink('ws/a/original-1')).searchParams.get('t')!;
    await request(app)
      .get(`/api/v1/audio?k=ws/a/original-1&t=${'0'.repeat(40)}`)
      .expect(403);
    await request(app).get('/api/v1/audio?k=ws/a/original-1').expect(403);
    await request(app).get(`/api/v1/audio?k=ws/b/original-9&t=${t}`).expect(403);
    expect(presigned).toEqual([]);
  });

  it('are what the meeting view gives the player for B2 audio, and Cloudinary links stay as stored', async () => {
    const b2 = await MeetingModel.create({
      workspaceId: workspace._id,
      title: 'On B2',
      audio: {
        originalUrl: 'b2://ws/a/original-7',
        originalPublicId: 'ws/a/original-7',
        playbackUrl: '',
      },
    });
    const old = await MeetingModel.create({
      workspaceId: workspace._id,
      title: 'On Cloudinary',
      audio: {
        originalUrl: 'https://res.cloudinary.com/x/o.webm',
        originalPublicId: 'ws/old/original',
        playbackUrl: 'https://res.cloudinary.com/x/o.mp3',
      },
    });
    const get = (id: unknown) =>
      request(app)
        .get(`/api/v1/meetings/${String(id)}`)
        .set('Authorization', `Bearer ${token}`);
    const a = (await get(b2._id)).body.meeting.audio.playbackUrl as string;
    expect(a).toBe(audioLink('ws/a/original-7'));
    const b = (await get(old._id)).body.meeting.audio.playbackUrl as string;
    expect(b).toBe('https://res.cloudinary.com/x/o.mp3');
    // and the link it gave actually plays
    const u = new URL(a);
    await request(app).get(`/api/v1/audio${u.search}`).redirects(0).expect(302);
  });
});
