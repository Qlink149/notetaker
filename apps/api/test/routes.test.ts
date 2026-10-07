import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import {
  JobModel,
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  type WorkspaceDoc,
} from '../src/models/index.js';
import { ACCESS_CODE, clearDb, fakeStorage, seedWorkspace, startDb, stopDb } from './helpers.js';

let app: Express;
let workspace: WorkspaceDoc;
let token: string;
const voiceprints: string[] = [];

beforeAll(async () => {
  await startDb();
  app = createApp({
    storage: await fakeStorage(),
    geminiFiles: {
      upload: async () => ({ uri: 'u', name: 'n', mimeType: 'audio/flac' }),
      delete: async () => undefined,
    },
    createVoiceprint: async (url) => {
      voiceprints.push(url);
      return 'vp-123';
    },
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

async function createMeeting(title = 'Weekly review') {
  const sign = await auth(request(app).post('/api/v1/uploads/sign')).expect(200);
  const { meetingId, folder } = sign.body as { meetingId: string; folder: string };
  const res = await auth(request(app).post('/api/v1/meetings'))
    .send({
      meetingId,
      title,
      publicId: `${folder}/rec`,
      url: 'https://res.cloudinary.com/x/rec.webm',
    })
    .expect(201);
  return res.body.meeting as {
    id: string;
    status: string;
    stage: string;
    engine: string;
    languages: string[];
  };
}

describe('auth', () => {
  it('health is public and reports the database', async () => {
    const res = await request(app).get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({ ok: true, db: 'up', worker: { lastHeartbeat: null } });
  });

  it('rejects a wrong access code and unauthenticated calls', async () => {
    await request(app).post('/api/v1/auth/login').send({ code: 'nope' }).expect(401);
    await request(app).get('/api/v1/meetings').expect(401);
    await request(app).get('/api/v1/meetings').set('Authorization', 'Bearer garbage').expect(401);
  });

  it('logs in with the access code and returns the workspace', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ code: ACCESS_CODE })
      .expect(200);
    expect(res.body.workspace).toMatchObject({ name: 'Kisna', slug: 'kisna' });
    expect(res.headers['set-cookie']?.[0]).toContain('mid_token=');
  });

  it('rotating the access code revokes old tokens', async () => {
    const res = await auth(request(app).post('/api/v1/workspace/access-code'))
      .send({ code: 'brand-new-code' })
      .expect(200);
    await auth(request(app).get('/api/v1/meetings')).expect(401);
    await request(app)
      .get('/api/v1/meetings')
      .set('Authorization', `Bearer ${res.body.token}`)
      .expect(200);
    await request(app).post('/api/v1/auth/login').send({ code: 'brand-new-code' }).expect(200);
  });
});

describe('meetings', () => {
  it('signs uploads into a per-meeting folder', async () => {
    const res = await auth(request(app).post('/api/v1/uploads/sign')).expect(200);
    expect(res.body.folder).toBe(`workspaces/kisna/meetings/${res.body.meetingId}`);
    expect(Types.ObjectId.isValid(res.body.meetingId)).toBe(true);
  });

  it('creates a meeting with workspace defaults and queues ingest', async () => {
    const m = await createMeeting();
    expect(m).toMatchObject({
      status: 'processing',
      stage: 'ingest',
      engine: 'gemini',
      languages: ['hi', 'gu', 'en'],
    });
    const jobs = await JobModel.find({ meetingId: m.id }).lean();
    expect(jobs.map((j) => j.stage)).toEqual(['ingest']);
  });

  it('refuses a publicId outside the meeting folder', async () => {
    const sign = await auth(request(app).post('/api/v1/uploads/sign'));
    await auth(request(app).post('/api/v1/meetings'))
      .send({
        meetingId: sign.body.meetingId,
        title: 't',
        publicId: 'meetings/shared/other',
        url: 'https://x.example/a',
      })
      .expect(400);
  });

  it('validates the body', async () => {
    await auth(request(app).post('/api/v1/meetings')).send({ title: '' }).expect(400);
  });

  it('lists, reads, renames and keeps the polled record small', async () => {
    const m = await createMeeting();
    // Simulate a long processed transcript in MeetingData
    const lines = Array.from({ length: 3000 }, (_, i) => ({
      speakerName: 'Speaker 1',
      start: i,
      end: i + 1,
      textRoman: 'kuch baat '.repeat(20),
      textNative: 'कुछ बात '.repeat(20),
    }));
    await MeetingDataModel.create({
      meetingId: m.id,
      lines,
      turns: [],
      chunks: [],
      speechSegments: [],
    });

    const list = await auth(request(app).get('/api/v1/meetings')).expect(200);
    expect(list.body.meetings).toHaveLength(1);
    const one = await auth(request(app).get(`/api/v1/meetings/${m.id}`)).expect(200);
    expect(JSON.stringify(one.body).length).toBeLessThan(20_000);
    const data = await auth(request(app).get(`/api/v1/meetings/${m.id}/data`)).expect(200);
    expect(data.body.lines).toHaveLength(3000);
    expect(data.headers['cache-control']).toBe('private, max-age=5');

    const renamed = await auth(request(app).patch(`/api/v1/meetings/${m.id}`))
      .send({ title: 'Renamed' })
      .expect(200);
    expect(renamed.body.meeting.title).toBe('Renamed');
  });

  it("hides other workspaces' meetings", async () => {
    const other = new Types.ObjectId();
    const id = new Types.ObjectId();
    await MeetingModel.create({
      _id: id,
      workspaceId: other,
      title: 'secret',
      audio: { originalUrl: 'u', originalPublicId: 'p' },
    });
    await auth(request(app).get(`/api/v1/meetings/${String(id)}`)).expect(404);
    await auth(request(app).get('/api/v1/meetings/not-an-id')).expect(404);
  });

  it('retries only the failed stage', async () => {
    const m = await createMeeting();
    await JobModel.updateMany({ meetingId: m.id }, { $set: { status: 'failed' } });
    await MeetingModel.updateOne(
      { _id: m.id },
      {
        $set: {
          status: 'failed',
          stage: 'summarise',
          error: { stage: 'summarise', message: 'x', retryable: true },
        },
      },
    );
    const res = await auth(request(app).post(`/api/v1/meetings/${m.id}/retry`))
      .send({ stage: 'summarise' })
      .expect(202);
    expect(res.body.meeting).toMatchObject({
      status: 'processing',
      stage: 'summarise',
      error: null,
    });
    const queued = await JobModel.find({ meetingId: m.id, status: 'queued' }).lean();
    expect(queued.map((j) => j.stage)).toEqual(['summarise']);
  });

  it('retry of transcribe re-queues only failed chunks', async () => {
    const m = await createMeeting();
    await JobModel.deleteMany({});
    await MeetingDataModel.create({
      meetingId: m.id,
      chunks: [
        { index: 0, startSec: 0, endSec: 600, status: 'done' },
        { index: 1, startSec: 570, endSec: 900, status: 'failed', attempts: 5 },
      ],
    });
    await auth(request(app).post(`/api/v1/meetings/${m.id}/retry`))
      .send({ stage: 'transcribe' })
      .expect(202);
    const jobs = await JobModel.find({ meetingId: m.id }).lean();
    expect(jobs.map((j) => [j.stage, j.step])).toEqual([['transcribe', 1]]);
    const meeting = await MeetingModel.findById(m.id).lean();
    expect(meeting?.progress).toEqual({ chunksTotal: 2, chunksDone: 1 });
  });

  it('refuses a retry while the meeting is still processing', async () => {
    const m = await createMeeting();
    await auth(request(app).post(`/api/v1/meetings/${m.id}/retry`))
      .send({ stage: 'ingest' })
      .expect(409);
  });

  it('summarise anyway queues a forced summary', async () => {
    const m = await createMeeting();
    await JobModel.deleteMany({});
    await MeetingModel.updateOne(
      { _id: m.id },
      {
        $set: {
          stage: 'done',
          status: 'partial',
          summaryStatus: 'skipped_low_coverage',
          coverage: { speechSec: 100, coveredSec: 30, ratio: 0.3 },
        },
      },
    );
    await auth(request(app).post(`/api/v1/meetings/${m.id}/summarise`))
      .send({ force: true })
      .expect(202);
    const job = await JobModel.findOne({ meetingId: m.id }).lean();
    expect(job).toMatchObject({ stage: 'summarise', payload: { force: true } });
  });

  it('deletes the meeting, its data and jobs', async () => {
    const m = await createMeeting();
    await MeetingDataModel.create({ meetingId: m.id });
    await auth(request(app).delete(`/api/v1/meetings/${m.id}`)).expect(204);
    expect(await MeetingModel.countDocuments()).toBe(0);
    expect(await MeetingDataModel.countDocuments()).toBe(0);
    expect(await JobModel.countDocuments()).toBe(0);
  });
});

describe('workspace settings and glossary', () => {
  it('reads and replaces the glossary', async () => {
    const before = await auth(request(app).get('/api/v1/glossary')).expect(200);
    expect(before.body.entries[0].term).toBe('Kisna');
    const entries = [
      { term: 'Kisna', kind: 'company', aliases: ['Kisna Diamond & Gold'] },
      { term: 'Tanishq', kind: 'competitor', aliases: [] },
    ];
    const put = await auth(request(app).put('/api/v1/glossary')).send({ entries }).expect(200);
    expect(put.body.entries).toHaveLength(2);
    await auth(request(app).put('/api/v1/glossary'))
      .send({ entries: [{ term: '', kind: 'x' }] })
      .expect(400);
  });

  it('updates settings', async () => {
    const settings = {
      engine: 'deepgram',
      languages: ['gu'],
      scriptPreference: 'native',
      summaryModel: 'claude-haiku-4-5',
    };
    const res = await auth(request(app).put('/api/v1/workspace/settings'))
      .send(settings)
      .expect(200);
    expect(res.body.settings).toEqual(settings);
    const m = await createMeeting();
    expect(m.engine).toBe('deepgram');
    expect(m.languages).toEqual(['gu']);
  });
});

describe('speakers', () => {
  it('enrols from a trimmed clip, lists and deletes', async () => {
    const res = await auth(request(app).post('/api/v1/speakers/enrol'))
      .send({ name: 'Heet Dholakia', trim: { publicId: 'p', start: 5, end: 20 } })
      .expect(201);
    expect(res.body.speaker).toMatchObject({ name: 'Heet Dholakia', hasVoiceprint: true });
    expect(voiceprints.at(-1)).toBe('wav://p/5-20');
    await auth(request(app).post('/api/v1/speakers/enrol'))
      .send({ name: 'Heet Dholakia', audioUrl: 'https://a.example/x.wav' })
      .expect(409);
    await auth(request(app).post('/api/v1/speakers/enrol'))
      .send({ name: 'Short', trim: { publicId: 'p', start: 0, end: 2 } })
      .expect(400);
    const list = await auth(request(app).get('/api/v1/speakers')).expect(200);
    expect(list.body.speakers).toHaveLength(1);
    await auth(request(app).delete(`/api/v1/speakers/${res.body.speaker.id}`)).expect(204);
    expect(await SpeakerModel.countDocuments()).toBe(0);
  });
});

describe('benchmark', () => {
  it('requires ingested meetings and creates a run with one result per meeting × engine', async () => {
    const m = await createMeeting();
    await auth(request(app).post('/api/v1/benchmark/run'))
      .send({ meetingIds: [m.id], engines: ['gemini'] })
      .expect(409);
    await MeetingDataModel.create({
      meetingId: m.id,
      chunks: [{ index: 0, startSec: 0, endSec: 60, audioUrl: 'x' }],
    });
    const res = await auth(request(app).post('/api/v1/benchmark/run'))
      .send({ meetingIds: [m.id], engines: ['gemini', 'deepgram'], evalSetName: 'four recordings' })
      .expect(202);
    expect(res.body.run.results).toHaveLength(2);
    expect(res.body.run.evalSetId).toBeTruthy();
    const jobs = await JobModel.find({ stage: 'benchmark' }).lean();
    expect(jobs).toHaveLength(2);
    const got = await auth(request(app).get(`/api/v1/benchmark/runs/${res.body.run.id}`)).expect(
      200,
    );
    expect(got.body.run.status).toBe('running');
    expect(String(workspace._id)).toBe(got.body.run.workspaceId);
  });
});

describe('access code security', () => {
  it('stores only a scrypt hash of the access code', async () => {
    const { WorkspaceModel } = await import('../src/models/index.js');
    const w = await WorkspaceModel.findOne({ slug: 'kisna' }).lean();
    expect(w?.accessCodeHash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(JSON.stringify(w)).not.toContain(ACCESS_CODE);
  });

  it('locks an IP out after 10 failed logins', async () => {
    const ip = '203.0.113.7';
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ code: `wrong-${i}` })
        .expect(401);
    }
    await request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ code: ACCESS_CODE })
      .expect(429);
    // other clients are unaffected
    await request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '203.0.113.8')
      .send({ code: ACCESS_CODE })
      .expect(200);
  });
});
