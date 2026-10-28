import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import {
  MeetingModel,
  SpeakerModel,
  WorkspaceModel,
  type WorkspaceDoc,
} from '../src/models/index.js';
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

const meeting = (title: string, workspaceId = workspace._id) =>
  MeetingModel.create({
    workspaceId,
    title,
    status: 'completed',
    stage: 'done',
    audio: {
      originalUrl: 'x',
      originalPublicId: 'x',
      playbackUrl: `https://audio.test/${title}.mp3`,
    },
  });

describe('listening to the voice samples saved for a person (28 Oct)', () => {
  it('lists every sample with its recording, where in it, and how long', async () => {
    const aom = await meeting('AOM Meeting part 1');
    const dv = await meeting('Google DV');
    const person = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Harshit Google DV360',
      voiceprints: [
        {
          id: 'a',
          voiceprint: 'a',
          source: 'meeting',
          meetingId: aom._id,
          clip: { start: 109.75, end: 134.67 },
        },
        {
          id: 'b',
          voiceprint: 'b',
          source: 'meeting',
          meetingId: dv._id,
          clip: { start: 152.13, end: 177.13 },
        },
      ],
    });
    const res = await auth(request(app).get(`/api/v1/speakers/${person._id}/samples`)).expect(200);
    expect(res.body.name).toBe('Harshit Google DV360');
    expect(res.body.samples).toHaveLength(2);
    expect(res.body.samples[0]).toMatchObject({
      index: 0,
      source: 'meeting',
      meetingId: String(aom._id),
      meetingTitle: 'AOM Meeting part 1',
      start: 109.75,
      end: 134.67,
      seconds: 24.9,
      audioUrl: 'https://audio.test/AOM Meeting part 1.mp3',
    });
    expect(res.body.samples[1]).toMatchObject({
      meetingTitle: 'Google DV',
      start: 152.13,
      seconds: 25,
    });
    // never exposes the voiceprint itself
    expect(JSON.stringify(res.body)).not.toContain('"voiceprint"');
  });

  it('plays a recorded sample from its own file, and copes with a meeting that is gone', async () => {
    const person = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Ghanshyam Dholakia',
      voiceprints: [
        {
          id: 'r',
          voiceprint: 'r',
          source: 'enrolment',
          audioUrl: 'https://audio.test/recorded.wav',
        },
        {
          id: 'g',
          voiceprint: 'g',
          source: 'meeting',
          meetingId: new Types.ObjectId(),
          clip: { start: 5, end: 12 },
        },
      ],
    });
    const { samples } = (
      await auth(request(app).get(`/api/v1/speakers/${person._id}/samples`)).expect(200)
    ).body;
    expect(samples[0]).toMatchObject({
      source: 'enrolment',
      meetingId: null,
      audioUrl: 'https://audio.test/recorded.wav',
    });
    expect(samples[1]).toMatchObject({ meetingId: null, meetingTitle: null });
  });

  it('is only for people of this workspace', async () => {
    const other = await WorkspaceModel.create({
      name: 'Other',
      slug: 'other',
      accessCodeHash: 'x',
    });
    const stranger = await SpeakerModel.create({
      workspaceId: other._id,
      name: 'Someone',
      voiceprints: [],
    });
    await auth(request(app).get(`/api/v1/speakers/${stranger._id}/samples`)).expect(404);
    await auth(request(app).get(`/api/v1/speakers/${new Types.ObjectId()}/samples`)).expect(404);
    await request(app).get(`/api/v1/speakers/${stranger._id}/samples`).expect(401);
  });
});
