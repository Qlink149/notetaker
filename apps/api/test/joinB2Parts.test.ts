import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { ParticipantModel, SessionModel } from '../src/models/session.js';
import { ACCESS_CODE, clearDb, fakeStorage, seedWorkspace, startDb, stopDb } from './helpers.js';

// Phones upload their audio parts straight to private storage, whose address is b2://<key>, not https://.
let app: Express;
let token: string;

beforeAll(async () => {
  await startDb();
  await mkdtemp(join(tmpdir(), 'b2parts-'));
  app = createApp({
    storage: await fakeStorage(),
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
  await seedWorkspace();
  const res = await request(app).post('/api/v1/auth/login').send({ code: ACCESS_CODE });
  token = res.body.token as string;
});

async function joined() {
  const created = await request(app)
    .post('/api/v1/sessions')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'b2 parts' })
    .expect(201);
  const code = (created.body as { code: string }).code;
  const j = await request(app).post(`/api/v1/join/${code}`).send({ name: 'Anil' }).expect(201);
  const pid = j.body.participantId as string;
  const session = await SessionModel.findOne({ code }).lean();
  return { code, pid, token: j.body.token as string, folder: session!.folder };
}

const part = (g: Awaited<ReturnType<typeof joined>>, over: Record<string, unknown>) => ({
  pid: g.pid,
  token: g.token,
  index: 0,
  bytes: 1000,
  startSample: 0,
  ...over,
});

describe('a phone filing an audio part in private storage', () => {
  it('is accepted when the address is exactly the key it was signed for', async () => {
    const g = await joined();
    const publicId = `${g.folder}/${g.pid}/original-abc123`;
    await request(app)
      .post(`/api/v1/join/${g.code}/parts`)
      .send(part(g, { publicId, url: `b2://${publicId}` }))
      .expect(200);
    const p = await ParticipantModel.findById(g.pid).lean();
    expect(p?.parts).toHaveLength(1);
    expect(p?.parts[0]?.url).toBe(`b2://${publicId}`);
  });

  it('is refused when the address points at a different file than the key', async () => {
    const g = await joined();
    const publicId = `${g.folder}/${g.pid}/original-abc123`;
    await request(app)
      .post(`/api/v1/join/${g.code}/parts`)
      .send(part(g, { publicId, url: 'b2://workspaces/kisna/meetings/someone-elses/original' }))
      .expect(400);
    expect((await ParticipantModel.findById(g.pid).lean())?.parts).toHaveLength(0);
  });

  it("still refuses a key outside the phone's own folder", async () => {
    const g = await joined();
    const publicId = `${g.folder}/another-phone/original-abc123`;
    await request(app)
      .post(`/api/v1/join/${g.code}/parts`)
      .send(part(g, { publicId, url: `b2://${publicId}` }))
      .expect(400);
  });

  it('still refuses an address that is not an uploaded file (plain http, other schemes)', async () => {
    const g = await joined();
    const publicId = `${g.folder}/${g.pid}/original-abc123`;
    for (const url of [`http://evil.test/${publicId}`, `ftp://x.test/${publicId}`, 'not a url']) {
      await request(app)
        .post(`/api/v1/join/${g.code}/parts`)
        .send(part(g, { publicId, url }))
        .expect(400);
    }
  });
});
