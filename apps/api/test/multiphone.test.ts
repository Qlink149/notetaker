import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { MeetingDataModel, MeetingModel, type WorkspaceDoc } from '../src/models/index.js';
import { LoudnessModel, SessionModel } from '../src/models/session.js';
import { Runner } from '../src/pipeline/runner.js';
import { stages } from '../src/pipeline/stages/index.js';
import {
  ACCESS_CODE,
  clearDb,
  fakeEngine,
  fakeStorage,
  fakeSummariser,
  okResult,
  seedWorkspace,
  startDb,
  stopDb,
  testDeps,
  turnsCovering,
} from './helpers.js';

const SR = 16000;
let app: Express;
let workspace: WorkspaceDoc;
let token: string;
let dir: string;
let storage: Awaited<ReturnType<typeof fakeStorage>>;
/** What the "cloud" holds: url -> local file. */
const cloud = new Map<string, string>();

beforeAll(async () => {
  await startDb();
  dir = await mkdtemp(join(tmpdir(), 'phones-'));
  const base = await fakeStorage();
  storage = {
    ...base,
    download: async (url, dest) => {
      const file = cloud.get(url);
      if (file) await copyFile(file, dest);
      else await base.download(url, dest); // the mix the stage uploaded
    },
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
  cloud.clear();
  workspace = await seedWorkspace();
  const res = await request(app).post('/api/v1/auth/login').send({ code: ACCESS_CODE });
  token = res.body.token as string;
});

const host = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${token}`);

/** Speech-like noise bursts (irregular timing) so envelopes carry structure. */
function speechLike(seconds: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out = new Float32Array(seconds * SR);
  let t = 0;
  while (t < out.length) {
    const on = Math.floor((0.2 + rnd() * 1.3) * SR);
    const off = Math.floor((0.15 + rnd() * 0.9) * SR);
    const amp = 0.15 + rnd() * 0.5;
    for (let i = 0; i < on && t + i < out.length; i++)
      out[t + i] = (rnd() * 2 - 1) * amp * (0.6 + 0.4 * Math.sin((i / SR) * 8 * Math.PI));
    t += on + off;
  }
  return out;
}

/** What a phone that started `delaySec` after Start hears: gain, a little noise, optional slow clock. */
function phoneHears(
  ref: Float32Array,
  delaySec: number,
  gain: number,
  drift = 0,
  seed = 5,
): Float32Array {
  const len = ref.length - Math.round(delaySec * SR);
  const out = new Float32Array(len);
  let s = seed >>> 0;
  for (let t = 0; t < len; t++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const src = t * (1 - drift) + delaySec * SR;
    const i = Math.floor(src);
    const f = src - i;
    const v = i + 1 < ref.length ? ref[i]! * (1 - f) + ref[i + 1]! * f : 0;
    out[t] = v * gain + (s / 4294967296 - 0.5) * 0.004;
  }
  return out;
}

async function wav(samples: Float32Array, path: string): Promise<void> {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++)
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), 44 + i * 2);
  await writeFile(path, buf);
}

describe('group recording (prototype, synthetic phones)', () => {
  it('joins, records, uploads, aligns three phones within 50 ms and runs the normal pipeline', async () => {
    // the room: 170 s of speech-like sound; three phones started 0, 2.7 and 11.2 s after "Start"
    const room = speechLike(170 + 12, 31);
    const phones = [
      { name: 'Anil', trueDelay: 0, reportedDelay: 0.15, audio: phoneHears(room, 0, 1) },
      {
        name: 'Bina',
        trueDelay: 2.7,
        reportedDelay: 2.3,
        audio: phoneHears(room, 2.7, 0.4, 0.001),
      },
      { name: 'Chirag', trueDelay: 11.2, reportedDelay: 10.9, audio: phoneHears(room, 11.2, 0.7) },
    ];

    const created = await host(request(app).post('/api/v1/sessions'))
      .send({ title: 'Synthetic' })
      .expect(201);
    const code = (created.body as { code: string }).code;
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    await host(request(app).post(`/api/v1/sessions/${code}/start`)).expect(409); // nobody joined

    const guests = [];
    for (const p of phones) {
      const j = await request(app)
        .post(`/api/v1/join/${code}`)
        .send({ name: p.name, deviceLabel: 'test phone' })
        .expect(201);
      guests.push({ ...p, pid: j.body.participantId as string, token: j.body.token as string });
    }
    // a wrong token cannot act as a participant
    await request(app)
      .post(`/api/v1/join/${code}/heartbeat`)
      .send({ pid: guests[0]!.pid, token: 'nope', level: -30 })
      .expect(401);

    const started = await host(request(app).post(`/api/v1/sessions/${code}/start`)).expect(200);
    const t0 = new Date((started.body as { startedAt: string }).startedAt).getTime();

    const session = await SessionModel.findOne({ code }).lean();
    for (const g of guests) {
      const beat = await request(app)
        .post(`/api/v1/join/${code}/heartbeat`)
        .send({ pid: g.pid, token: g.token, level: -24, status: 'recording' })
        .expect(200);
      expect(beat.body).toMatchObject({ state: 'recording' });
      await request(app)
        .post(`/api/v1/join/${code}/sign`)
        .send({ pid: g.pid, token: g.token })
        .expect(200);
      // 60 s parts
      const partLen = 60 * SR;
      for (let i = 0; i * partLen < g.audio.length; i++) {
        const file = join(dir, `${g.name}-${i}.wav`);
        await wav(g.audio.subarray(i * partLen, (i + 1) * partLen), file);
        const publicId = `${session!.folder}/${g.pid}/part-${i}`;
        const url = `https://cloud.test/${publicId}.wav`;
        cloud.set(url, file);
        await request(app)
          .post(`/api/v1/join/${code}/parts`)
          .send({
            pid: g.pid,
            token: g.token,
            index: i,
            publicId,
            url,
            bytes: 1000,
            startSample: i * partLen,
            // the phone's own estimate of the server clock at its first sample: a few hundred ms off
            firstSampleServerMs: t0 + g.reportedDelay * 1000,
          })
          .expect(200);
      }
      await request(app)
        .post(`/api/v1/join/${code}/heartbeat`)
        .send({ pid: g.pid, token: g.token, status: 'uploaded' })
        .expect(200);
    }
    // a part cannot be filed under another phone's folder
    await request(app)
      .post(`/api/v1/join/${code}/parts`)
      .send({
        pid: guests[0]!.pid,
        token: guests[0]!.token,
        index: 9,
        publicId: `${session!.folder}/${guests[1]!.pid}/x`,
        url: 'https://x.test/a',
        bytes: 1,
        startSample: 0,
      })
      .expect(400);

    await host(request(app).post(`/api/v1/sessions/${code}/finish`)).expect(409); // not stopped yet
    await host(request(app).post(`/api/v1/sessions/${code}/stop`)).expect(200);
    const live = await host(request(app).get(`/api/v1/sessions/${code}`)).expect(200);
    expect(
      (live.body as { participants: { parts: number }[] }).participants.every((p) => p.parts >= 3),
    ).toBe(true);
    await host(request(app).post(`/api/v1/sessions/${code}/finish`)).expect(202);

    const runner = new Runner(
      testDeps({
        storage,
        engine: () =>
          fakeEngine((input) => okResult(turnsCovering(0, input.endSec - input.startSec))),
        summariser: fakeSummariser(),
      }),
      stages,
    );
    await runner.drain();

    const done = await SessionModel.findOne({ code }).lean();
    expect(done?.state).toBe('done');
    const tracks = (
      done?.report as {
        tracks: {
          name: string;
          coarseSec: number;
          fineSec: number | null;
          driftPpm: number | null;
          method: string;
        }[];
      }
    ).tracks;
    // alignment error: where the combined shift puts each phone versus where it truly started
    const ref = tracks.find((t) => t.method === 'reference')!;
    const refTrue = phones.find((p) => p.name === ref.name)!.trueDelay;
    // everything is aligned to the reference phone's content, so its own timestamp error is shared
    const shared = ref.coarseSec - refTrue;
    const errors: Record<string, number> = {};
    for (const g of guests) {
      const t = tracks.find((x) => x.name === g.name)!;
      expect(t.method === 'reference' || t.method === 'envelope').toBe(true);
      errors[g.name] = t.coarseSec + (t.fineSec ?? 0) - (g.trueDelay + shared);
      expect(Math.abs(errors[g.name]!)).toBeLessThan(0.05);
    }
    // the coarse timestamps alone were off by 150-400 ms; this is what the alignment fixed
    expect(Math.max(...phones.map((p) => Math.abs(p.reportedDelay - p.trueDelay)))).toBeGreaterThan(
      0.3,
    );
    expect(tracks.find((t) => t.name === 'Bina')!.driftPpm).toBeGreaterThan(500);
    expect(tracks.find((t) => t.name === 'Bina')!.driftPpm).toBeLessThan(1500);

    // the mix became the meeting's recording and went through the normal pipeline
    const meeting = await MeetingModel.findById(done!.meetingId).lean();
    expect(meeting?.status).toBe('completed');
    expect(meeting?.expectedParticipants).toBe(3);
    expect(meeting?.durationSec).toBeGreaterThan(160);
    const loud = await LoudnessModel.find({ sessionId: done!._id }).lean();
    expect(loud).toHaveLength(3);
    expect(loud[0]!.db.length).toBeGreaterThan(300);
    const data = await MeetingDataModel.findOne({ meetingId: done!.meetingId }).lean();
    expect(data?.lines.length).toBeGreaterThan(0);
  }, 120_000);

  it('does not let a session be joined once recording has been stopped', async () => {
    const created = await host(request(app).post('/api/v1/sessions')).send({}).expect(201);
    const code = (created.body as { code: string }).code;
    await request(app).post(`/api/v1/join/${code}`).send({ name: 'Anil' }).expect(201);
    await host(request(app).post(`/api/v1/sessions/${code}/start`)).expect(200);
    await host(request(app).post(`/api/v1/sessions/${code}/stop`)).expect(200);
    await request(app).post(`/api/v1/join/${code}`).send({ name: 'Late' }).expect(409);
    await request(app).post('/api/v1/join/ZZZZZZ').send({ name: 'x' }).expect(404);
    await request(app).post(`/api/v1/sessions/${code}/finish`).expect(401); // hosts only
    await host(request(app).post(`/api/v1/sessions/${code}/finish`)).expect(409); // nothing uploaded
  });
});
