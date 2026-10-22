import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { identifyMeeting } from '../src/services/identity/enroll.js';
import {
  EngineResponseModel,
  JobModel,
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  type SpeakerCardDoc,
  type WorkspaceDoc,
} from '../src/models/index.js';
import { P2JoinModel, P2MediaModel, P2PyannoteResponseModel } from '../src/models/phase2.js';
import { meetingFolder } from '../src/services/storage/cloudinary.js';
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

const card = (
  diar: string,
  label: string,
  personId: string | null,
  extra: Partial<SpeakerCardDoc> = {},
): SpeakerCardDoc => ({
  diar,
  label,
  personId,
  speakerSec: 50,
  match: null,
  candidate: null,
  status: 'new',
  clips: [{ start: 0, end: 10, quality: 80 }],
  ...extra,
});

const diarizeDoc = (meetingId: Types.ObjectId, jobId: string, diarization: object[]) => ({
  meetingId,
  kind: 'diarize' as const,
  model: 'precision-2' as const,
  tag: 'pipeline',
  status: 'succeeded' as const,
  jobId,
  keyLabel: 'PYANNOTEAI_API_KEY',
  submittedAt: new Date(),
  output: { diarization },
});

/**
 * A finished 100-second meeting: Heet (S0, named and confirmed) and an unnamed voice (S1, an anonymous person
 * made from this meeting), with its stored speaker analysis, word clock and gap fills.
 */
async function seedFinished() {
  const id = new Types.ObjectId();
  const folder = meetingFolder(workspace.slug, String(id));
  const heet = await SpeakerModel.create({
    workspaceId: workspace._id,
    name: 'Heet Dholakia',
    anonymous: false,
  });
  const unnamed = await SpeakerModel.create({
    workspaceId: workspace._id,
    name: 'Speaker B (Meeting Plan)',
    anonymous: true,
    origin: { meetingId: id, diar: 'S1' },
  });
  await MeetingModel.create({
    _id: id,
    workspaceId: workspace._id,
    title: 'Plan',
    status: 'completed',
    stage: 'done',
    durationSec: 100,
    audio: {
      originalUrl: 'b2://first',
      originalPublicId: `${folder}/first.m4a`,
      playbackUrl: 'x',
    },
  });
  await MeetingDataModel.create({
    meetingId: id,
    speakerSource: 'pyannote',
    speakerCards: [
      card('S0', 'Speaker A', String(heet._id), { status: 'manual', confirmed: true }),
      card('S1', 'Speaker B', String(unnamed._id)),
    ],
    gapFills: [
      { start: 10, end: 20, cutStart: 5, cutEnd: 25, status: 'done', turns: [] },
      { start: 80, end: 90, cutStart: 75, cutEnd: 95, status: 'done', turns: [] },
    ],
  });
  await P2PyannoteResponseModel.create(
    diarizeDoc(id, 'old', [
      { speaker: 'S0', start: 0, end: 20 },
      { speaker: 'S1', start: 20, end: 50 },
      { speaker: 'S0', start: 50, end: 80 },
      { speaker: 'S1', start: 80, end: 100 },
    ]),
  );
  await EngineResponseModel.create({
    meetingId: id,
    kind: 'words',
    engine: 'deepgram',
    model: 'nova-3/hi',
    promptVersion: 'deepgram-words-v1',
    status: 'ok',
    response: {},
    error: null,
    receivedAt: new Date(),
  });
  await P2MediaModel.create({
    _id: 'media://p2-old.flac',
    meetingId: id,
    kind: 'meeting',
    durationSec: 100,
    uploadedAt: new Date(),
  });
  await P2JoinModel.create({ meetingId: id, method: 'joined', lines: [] });
  return { id, folder, heet, unnamed };
}

describe('adding a continuation to a meeting (client request, 20 Oct)', () => {
  it('queues the new audio after the old, and retires what was made from the old recording only', async () => {
    const { id, folder, unnamed } = await seedFinished();
    const res = await auth(request(app).post(`/api/v1/meetings/${String(id)}/parts`))
      .send({
        parts: [
          {
            publicId: `${folder}/later.m4a`,
            url: `b2://${folder}/later.m4a`,
            fileName: 'later.m4a',
          },
        ],
      })
      .expect(202);
    expect(res.body.meeting.status).toBe('processing');

    const m = await MeetingModel.findById(id).lean();
    expect(m?.audio.originalUrl).toBe('pending:concat');
    // the earlier recording becomes part 1
    expect(m?.audio.parts?.map((p) => [p.url, p.fileName, p.offsetSec])).toEqual([
      ['b2://first', null, 0],
      [`b2://${folder}/later.m4a`, 'later.m4a', null],
    ]);
    expect(
      await JobModel.countDocuments({ meetingId: id, stage: 'concat', status: 'queued' }),
    ).toBe(1);

    // stored speaker analysis, uploaded audio, word clock and join belong to the old recording
    const old = await P2PyannoteResponseModel.findOne({ meetingId: id, jobId: 'old' }).lean();
    expect(old?.tag).toBe('before-added-audio:pipeline');
    expect(await P2MediaModel.countDocuments({ meetingId: id })).toBe(0);
    expect(await P2JoinModel.countDocuments({ meetingId: id })).toBe(0);
    const words = await EngineResponseModel.findOne({ meetingId: id, kind: 'words' }).lean();
    expect(words?.error).toMatch(/superseded/);

    // gap fills well inside the earlier audio are kept; one near its end is redone
    const data = await MeetingDataModel.findOne({ meetingId: id }).lean();
    expect(data?.gapFills.map((g) => g.start)).toEqual([10]);
    // the decisions and the voices they were made on are kept aside for the next identification
    expect(data?.carryOver?.endSec).toBe(100);
    expect(data?.carryOver?.cards.map((c) => c.diar)).toEqual(['S0', 'S1']);
    expect(data?.carryOver?.segments).toHaveLength(4);
    expect(data?.speakerCards).toEqual([]);
    expect((await SpeakerModel.findById(unnamed._id).lean())?.origin?.diar).toBe('pre:S1');
  });

  it('refuses while the meeting is processing, and files outside the meeting folder', async () => {
    const { id, folder } = await seedFinished();
    await auth(request(app).post(`/api/v1/meetings/${String(id)}/parts`))
      .send({ parts: [{ publicId: 'elsewhere/x.m4a', url: 'b2://x' }] })
      .expect(400);
    await MeetingModel.updateOne({ _id: id }, { $set: { status: 'processing' } });
    await auth(request(app).post(`/api/v1/meetings/${String(id)}/parts`))
      .send({ parts: [{ publicId: `${folder}/later.m4a`, url: `b2://${folder}/later.m4a` }] })
      .expect(409);
    // nothing was touched
    const old = await P2PyannoteResponseModel.findOne({ meetingId: id, jobId: 'old' }).lean();
    expect(old?.tag).toBe('pipeline');
  });

  it('refuses an address that is not the uploaded file (the server would fetch it)', async () => {
    const { id, folder } = await seedFinished();
    for (const url of [
      'http://169.254.169.254/latest',
      `b2://${folder}/other.m4a`,
      'https://evil.example/x',
    ])
      await auth(request(app).post(`/api/v1/meetings/${String(id)}/parts`))
        .send({ parts: [{ publicId: `${folder}/later.m4a`, url }] })
        .expect(400);
    expect((await MeetingModel.findById(id).lean())?.status).toBe('completed');
  });

  it('two requests at the same moment add the audio once and keep the speaker names', async () => {
    const { id, folder } = await seedFinished();
    const send = () =>
      auth(request(app).post(`/api/v1/meetings/${String(id)}/parts`)).send({
        parts: [{ publicId: `${folder}/later.m4a`, url: `b2://${folder}/later.m4a` }],
      });
    const codes = (await Promise.all([send(), send()])).map((r) => r.status).sort();
    expect(codes).toEqual([202, 409]);
    const m = await MeetingModel.findById(id).lean();
    expect(m?.audio.parts).toHaveLength(2);
    const data = await MeetingDataModel.findOne({ meetingId: id }).lean();
    expect(data?.carryOver?.cards.map((c) => c.diar)).toEqual(['S0', 'S1']);
  });

  it('puts things back when the new speaker analysis falls back to text speakers', async () => {
    const { id, folder, unnamed } = await seedFinished();
    await auth(request(app).post(`/api/v1/meetings/${String(id)}/parts`))
      .send({ parts: [{ publicId: `${folder}/later.m4a`, url: `b2://${folder}/later.m4a` }] })
      .expect(202);
    expect((await SpeakerModel.findById(unnamed._id).lean())?.origin?.diar).toBe('pre:S1');
    const { releaseCarryOver } = await import('../src/services/continuation.js');
    await releaseCarryOver(id);
    expect((await SpeakerModel.findById(unnamed._id).lean())?.origin?.diar).toBe('S1');
    expect((await MeetingDataModel.findOne({ meetingId: id }).lean())?.carryOver).toBeNull();
  });

  it('keeps who each voice is when the new analysis labels the voices differently', async () => {
    const { id, folder, heet, unnamed } = await seedFinished();
    await auth(request(app).post(`/api/v1/meetings/${String(id)}/parts`))
      .send({ parts: [{ publicId: `${folder}/later.m4a`, url: `b2://${folder}/later.m4a` }] })
      .expect(202);
    // the join and the new speaker analysis ran on 200 s: Heet is now X1, the unnamed voice X0, and a third
    // voice speaks only in the new audio
    await MeetingModel.updateOne({ _id: id }, { $set: { durationSec: 200 } });
    await P2PyannoteResponseModel.create(
      diarizeDoc(id, 'new', [
        { speaker: 'X1', start: 0, end: 21 },
        { speaker: 'X0', start: 21, end: 49 },
        { speaker: 'X1', start: 49, end: 80 },
        { speaker: 'X0', start: 80, end: 130 },
        { speaker: 'X2', start: 130, end: 200 },
      ]),
    );

    // no known voices from other meetings and no voiceprint budget: no pyannote call is made
    await identifyMeeting(String(id), String(workspace._id), { budget: { left: 0 } });

    const data = await MeetingDataModel.findOne({ meetingId: id }).lean();
    const by = new Map((data!.speakerCards as SpeakerCardDoc[]).map((c) => [c.diar, c]));
    // Heet's decision follows his voice
    expect(by.get('X1')).toMatchObject({
      personId: String(heet._id),
      confirmed: true,
      status: 'manual',
    });
    // the person made from the unnamed voice stays that voice's person, under its new label
    expect(by.get('X0')?.personId).toBe(String(unnamed._id));
    expect((await SpeakerModel.findById(unnamed._id).lean())?.origin?.diar).toBe('X0');
    // the new voice gets its own new person, not anyone's earlier one
    const third = by.get('X2')?.personId;
    expect(third).toBeTruthy();
    expect([String(heet._id), String(unnamed._id)]).not.toContain(third);
    // done once
    expect(data?.carryOver).toBeNull();
  });
});
