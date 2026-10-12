import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  JobModel,
  MeetingDataModel,
  MeetingModel,
  type WorkspaceDoc,
} from '../src/models/index.js';
import { ACCESS_CODE, clearDb, fakeStorage, seedWorkspace, startDb, stopDb } from './helpers.js';

// A meeting whose speakers were guessed from the text (the voice analysis did not run) can have just
// the voice analysis run again. The meeting waits at `transcribe`, where the pipeline moves on to
// assemble once transcription and voice analysis are both done.
let app: Express;
let workspace: WorkspaceDoc;
let token: string;

beforeAll(async () => {
  await startDb();
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
  workspace = await seedWorkspace();
  const res = await request(app).post('/api/v1/auth/login').send({ code: ACCESS_CODE });
  token = res.body.token as string;
});

async function finishedMeeting(): Promise<string> {
  const m = await MeetingModel.create({
    workspaceId: workspace._id,
    title: 'Done without voices',
    status: 'completed',
    stage: 'done',
    audio: { originalUrl: 'x', originalPublicId: 'x' },
  });
  await MeetingDataModel.create({
    meetingId: m._id,
    chunks: [{ index: 0, startSec: 0, endSec: 600, status: 'done', attempts: 1 }],
    diarize: { state: 'fallback', jobId: null, reason: 'diarization given up' },
  });
  return String(m._id);
}
const retry = (id: string, stage: string) =>
  request(app)
    .post(`/api/v1/meetings/${id}/retry`)
    .set('Authorization', `Bearer ${token}`)
    .send({ stage });

describe('re-run the voice analysis', () => {
  it('queues only the voice analysis and parks the meeting where assembly waits for it', async () => {
    const id = await finishedMeeting();
    const res = await retry(id, 'diarize').expect(202);
    expect(res.body.meeting).toMatchObject({
      status: 'processing',
      stage: 'transcribe',
      error: null,
    });
    const data = await MeetingDataModel.findOne({ meetingId: id }).lean();
    expect(data!.diarize).toMatchObject({ state: 'pending', jobId: null });
    const jobs = await JobModel.find({ meetingId: id }).lean();
    expect(jobs.map((j) => `${j.stage}:${j.status}`)).toEqual(['diarize:queued']);
  });

  it('clears an earlier failed voice-analysis job so it is not mistaken for a retry limit', async () => {
    const id = await finishedMeeting();
    await JobModel.create({ meetingId: id, stage: 'diarize', status: 'failed', attempts: 256 });
    await retry(id, 'diarize').expect(202);
    const jobs = await JobModel.find({ meetingId: id }).lean();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('refuses while the meeting is still processing, and an unknown stage', async () => {
    const id = await finishedMeeting();
    await retry(id, 'diarize').expect(202);
    await retry(id, 'diarize').expect(409);
    await retry(id, 'nonsense').expect(400);
  });
});
