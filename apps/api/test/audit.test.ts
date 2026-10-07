import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { MeetingModel, type WorkspaceDoc } from '../src/models/index.js';
import { P2JoinModel, P2PyannoteResponseModel } from '../src/models/phase2.js';
import { ACCESS_CODE, clearDb, fakeStorage, seedWorkspace, startDb, stopDb } from './helpers.js';

let app: Express;
let workspace: WorkspaceDoc;
let token: string;

beforeAll(async () => {
  await startDb();
  app = createApp({
    storage: await fakeStorage(),
    geminiFiles: {
      upload: async () => ({ uri: 'u', name: 'n', mimeType: 'audio/flac', keyId: 'k1' }),
      delete: async () => undefined,
    },
    createVoiceprint: async () => 'vp',
  });
});
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  workspace = await seedWorkspace();
  const res = await request(app).post('/api/v1/auth/login').send({ code: ACCESS_CODE });
  token = res.body.token as string;
});

const auth = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${token}`);

/** A meeting with M1 and M3 lines for two speakers, and a stored pyannote diarization. */
async function seedJoined(): Promise<string> {
  const m = await MeetingModel.create({
    workspaceId: workspace._id,
    title: 'Meeting-21-9-2026 (acceptance)',
    durationSec: 400,
    audio: { originalUrl: 'x', originalPublicId: 'x', playbackUrl: 'https://audio.test/x.mp3' },
  });
  const segs: { speaker: string; start: number; end: number }[] = [];
  const lines = (offset: number) =>
    Array.from({ length: 40 }, (_, i) => {
      const dur = i % 3 === 0 ? 1.5 : 6;
      const start = offset + i * 8;
      segs.push({ speaker: i % 2 ? 'SPEAKER_01' : 'SPEAKER_00', start, end: start + dur });
      return {
        speakerName: i % 2 ? 'Speaker B' : 'Speaker A',
        start,
        end: start + dur,
        textNative: `native ${i}`,
        textRoman: `roman ${i}`,
      };
    });
  const m1Lines = lines(0);
  const speakerMap = { SPEAKER_00: 'Speaker A', SPEAKER_01: 'Speaker B' };
  await P2JoinModel.create({
    meetingId: m._id,
    method: 'm1',
    lines: m1Lines,
    turns: [],
    speakerMap,
  });
  await P2JoinModel.create({
    meetingId: m._id,
    method: 'm3',
    lines: m1Lines,
    turns: [],
    speakerMap,
  });
  await P2PyannoteResponseModel.create({
    meetingId: m._id,
    kind: 'diarize',
    model: 'precision-2',
    tag: 'stageA',
    jobId: 'job-1',
    status: 'succeeded',
    submittedAt: new Date(),
    output: { diarization: segs, exclusiveDiarization: segs },
    keyLabel: 'PYANNOTEAI_API_KEY',
  });
  return String(m._id);
}

describe('blind audit', () => {
  it('seeds a shuffled sample that hides the method, with a third short lines', async () => {
    const id = await seedJoined();
    await auth(request(app).post(`/api/v1/audit/${id}/seed`))
      .send({ perMethod: 12 })
      .expect(200);
    const res = await auth(request(app).get(`/api/v1/audit/${id}`)).expect(200);
    const body = res.body as {
      items: { id: string; start: number; end: number; assigned: string }[];
      clusters: { diar: string; clips: unknown[] }[];
      meeting: { title: string; playbackUrl: string };
    };
    expect(body.items).toHaveLength(24);
    expect(JSON.stringify(body)).not.toMatch(/"method"/);
    const short = body.items.filter((i) => i.end - i.start < 3).length;
    expect(short).toBe(8); // a third of 12 per method, two methods
    expect(body.meeting).toMatchObject({ title: '21/9', playbackUrl: 'https://audio.test/x.mp3' });
    expect(body.clusters.map((c) => c.diar).sort()).toEqual(['SPEAKER_00', 'SPEAKER_01']);
    expect(body.items.every((i) => ['Speaker A', 'Speaker B'].includes(i.assigned))).toBe(true);
    // seeding again keeps the same sample
    const again = await auth(request(app).post(`/api/v1/audit/${id}/seed`))
      .send({})
      .expect(200);
    expect(again.body).toMatchObject({ seeded: false, items: 24 });
  });

  it('uses typed names, follows “same person as”, and tallies answers per method', async () => {
    const id = await seedJoined();
    await auth(request(app).post(`/api/v1/audit/${id}/seed`))
      .send({ perMethod: 6 })
      .expect(200);
    await auth(request(app).put(`/api/v1/audit/${id}/naming`))
      .send({ names: { SPEAKER_00: 'Ghanshyam' }, sameAs: { SPEAKER_01: 'SPEAKER_00' } })
      .expect(200);
    const got = (await auth(request(app).get(`/api/v1/audit/${id}`)).expect(200)).body as {
      items: { id: string; assigned: string }[];
    };
    expect(new Set(got.items.map((i) => i.assigned))).toEqual(new Set(['Ghanshyam']));

    // answer every item: m1 items right, m3 items wrong (the id prefix is the hidden method)
    for (const it of got.items) {
      await auth(request(app).patch(`/api/v1/audit/${id}/items/${it.id}`))
        .send({ speaker: it.id.startsWith('m1') ? 'right' : 'wrong', text: 'match' })
        .expect(200);
    }
    const results = (await auth(request(app).get('/api/v1/audit/results/all')).expect(200))
      .body as {
      methods: {
        method: string;
        speakerCorrectRate: number;
        wrongNameRate: number;
        answered: number;
      }[];
    };
    const m1 = results.methods.find((t) => t.method === 'm1')!;
    const m3 = results.methods.find((t) => t.method === 'm3')!;
    expect(m1).toMatchObject({ answered: 6, speakerCorrectRate: 1, wrongNameRate: 0 });
    expect(m3).toMatchObject({ answered: 6, speakerCorrectRate: 0, wrongNameRate: 1 });
  });

  it('refuses to reseed once answers exist, and lists only joined meetings', async () => {
    const id = await seedJoined();
    await auth(request(app).post(`/api/v1/audit/${id}/seed`))
      .send({})
      .expect(200);
    const first = (await auth(request(app).get(`/api/v1/audit/${id}`)).expect(200)).body as {
      items: { id: string }[];
    };
    await auth(request(app).patch(`/api/v1/audit/${id}/items/${first.items[0]!.id}`))
      .send({ speaker: 'right' })
      .expect(200);
    await auth(request(app).post(`/api/v1/audit/${id}/seed`))
      .send({ force: true })
      .expect(409);
    const list = (await auth(request(app).get('/api/v1/audit')).expect(200)).body as {
      meetings: { id: string; answered: number; items: number }[];
    };
    expect(list.meetings).toEqual([
      expect.objectContaining({ id, answered: 1, items: 30, seeded: true }),
    ]);
  });
});
