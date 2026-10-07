import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Turn } from '@meetingid/shared';
import { createApp } from '../src/app.js';
import { applyNames } from '../src/services/identity/identity.js';
import {
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  type SpeakerCardDoc,
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

const turn = (speaker: string, start: number, end: number, text: string): Turn => ({
  speaker,
  start,
  end,
  textNative: text,
  textRoman: text,
  lang: 'mixed',
});

const card = (
  diar: string,
  label: string,
  personId: string | null,
  extra: Partial<SpeakerCardDoc> = {},
): SpeakerCardDoc => ({
  diar,
  label,
  personId,
  speakerSec: 30,
  match: null,
  candidate: null,
  status: 'new',
  clips: [{ start: 0, end: 10, quality: 80 }],
  ...extra,
});

/** A meeting whose speakers come from pyannote; returns its id. */
async function seedMeeting(title: string, turns: Turn[], cards: SpeakerCardDoc[]): Promise<string> {
  const m = await MeetingModel.create({
    workspaceId: workspace._id,
    title,
    status: 'completed',
    stage: 'done',
    audio: { originalUrl: 'x', originalPublicId: 'x', playbackUrl: 'x' },
  });
  await MeetingDataModel.create({
    meetingId: m._id,
    turns,
    speakerCards: cards,
    speakerSource: 'pyannote',
    speechSegments: [{ start: 0, end: 100 }],
  });
  await applyNames(String(m._id));
  return String(m._id);
}

const speakers = async (id: string) =>
  (await auth(request(app).get(`/api/v1/meetings/${id}/speakers`)).expect(200)).body as {
    cards: {
      diar: string;
      displayName: string;
      label: string;
      personId: string | null;
      appearsIn: { title: string; label: string }[];
    }[];
  };

const lineNames = async (id: string): Promise<string[]> =>
  ((await MeetingDataModel.findOne({ meetingId: id }).lean())?.lines ?? []).map(
    (l) => l.speakerName,
  );

describe('naming a voice', () => {
  it('shows the new name in every meeting where that voice was recognised', async () => {
    const person = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Speaker B (Meeting 21/9)',
      anonymous: true,
    });
    const pid = String(person._id);
    const a = await seedMeeting(
      'Meeting-21-9-2026',
      [turn('S0', 0, 5, 'one'), turn('S1', 5, 10, 'two')],
      [card('S0', 'Speaker A', null), card('S1', 'Speaker B', pid)],
    );
    const b = await seedMeeting(
      'AOM Meeting part 1',
      [turn('S4', 0, 5, 'three'), turn('S5', 5, 10, 'four')],
      [
        card('S4', 'Speaker A', null),
        card('S5', 'Speaker C', pid, {
          status: 'solid',
          match: { personId: pid, name: 'Speaker B (Meeting 21/9)', score: 78, margin: 11 },
        }),
      ],
    );

    await auth(request(app).post(`/api/v1/meetings/${a}/speakers/S1/name`))
      .send({ name: 'Ghanshyam Dholakia' })
      .expect(200)
      .then((r) => {
        expect((r.body as { updatedMeetings: string[] }).updatedMeetings.sort()).toEqual(
          [a, b].sort(),
        );
      });

    expect(await lineNames(a)).toEqual(['Speaker A', 'Ghanshyam Dholakia']);
    expect(await lineNames(b)).toEqual(['Speaker A', 'Ghanshyam Dholakia']);
    const view = await speakers(a);
    const ghan = view.cards.find((c) => c.diar === 'S1')!;
    expect(ghan.displayName).toBe('Ghanshyam Dholakia');
    expect(ghan.appearsIn[0]).toMatchObject({ title: 'AOM', label: 'Speaker C' });
  });

  it('asks before creating a near-duplicate name, and can link to the existing person', async () => {
    const existing = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Ghanshyam Dholakia',
      anonymous: false,
      voiceprints: [{ id: 'v1', source: 'meeting', audioUrl: '', voiceprint: 'vp-a' }],
    });
    const anon = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Speaker A (Meeting AOM)',
      anonymous: true,
      voiceprints: [{ id: 'v2', source: 'meeting', audioUrl: '', voiceprint: 'vp-b' }],
    });
    const id = await seedMeeting(
      'AOM',
      [turn('S0', 0, 5, 'x')],
      [card('S0', 'Speaker A', String(anon._id))],
    );

    const clash = await auth(request(app).post(`/api/v1/meetings/${id}/speakers/S0/name`))
      .send({ name: 'ghanshyam  dholkia' })
      .expect(409);
    expect(clash.body).toMatchObject({
      error: 'similar_name',
      similar: [{ id: String(existing._id), name: 'Ghanshyam Dholakia' }],
    });

    await auth(request(app).post(`/api/v1/meetings/${id}/speakers/S0/name`))
      .send({ name: 'ghanshyam dholkia', usePersonId: String(existing._id) })
      .expect(200);
    expect(await lineNames(id)).toEqual(['Ghanshyam Dholakia']);
    // the anonymous duplicate is gone and its voiceprint now belongs to the existing person
    expect(await SpeakerModel.countDocuments({ workspaceId: workspace._id })).toBe(1);
    const merged = await SpeakerModel.findById(existing._id).lean();
    expect(merged!.voiceprints).toHaveLength(2);
  });

  it('creates a person when a voice had none, and keeps a new name when asked', async () => {
    const id = await seedMeeting(
      'Prachar',
      [turn('S0', 0, 5, 'x')],
      [card('S0', 'Speaker A', null)],
    );
    await auth(request(app).post(`/api/v1/meetings/${id}/speakers/S0/name`))
      .send({ name: 'Rajesh Patel' })
      .expect(200);
    expect(await lineNames(id)).toEqual(['Rajesh Patel']);
    const p = await SpeakerModel.findOne({ name: 'Rajesh Patel' }).lean();
    expect(p).toMatchObject({ anonymous: false });

    await auth(request(app).post(`/api/v1/meetings/${id}/speakers/S0/name`))
      .send({ name: 'Rajesh Patal', createNew: true })
      .expect(200);
    expect(await lineNames(id)).toEqual(['Rajesh Patal']);
  });
});

describe('merge, split and reassign', () => {
  const turns = [
    turn('S0', 0, 4, 'a'),
    turn('S1', 4, 8, 'b'),
    turn('S0', 8, 12, 'c'),
    turn('S2', 12, 16, 'd'),
    turn('S0', 16, 20, 'e'),
  ];
  const cards = () => [
    card('S0', 'Speaker A', null, { speakerSec: 12 }),
    card('S1', 'Speaker B', null, { speakerSec: 4 }),
    card('S2', 'Speaker C', null, { speakerSec: 4 }),
  ];

  it('merging two speakers joins their lines and re-merges neighbours', async () => {
    const id = await seedMeeting('M', turns, cards());
    await auth(request(app).post(`/api/v1/meetings/${id}/speakers/merge`))
      .send({ from: 'S1', into: 'S0' })
      .expect(200);
    // a, b, c are now one speaker with short pauses: one line; then S2; then S0
    expect(await lineNames(id)).toEqual(['Speaker A', 'Speaker C', 'Speaker A']);
    const view = await speakers(id);
    expect(view.cards.map((c) => c.diar)).toEqual(['S0', 'S2']);
  });

  it('merge refuses the same speaker twice', async () => {
    const id = await seedMeeting('M', turns, cards());
    await auth(request(app).post(`/api/v1/meetings/${id}/speakers/merge`))
      .send({ from: 'S0', into: 'S0' })
      .expect(400);
  });

  it('splitting from a line onward makes a new speaker for the rest of that voice', async () => {
    const id = await seedMeeting('M', turns, cards());
    const lines = (await MeetingDataModel.findOne({ meetingId: id }).lean())!.lines;
    const idx = lines.findIndex((l) => l.start >= 8);
    const res = await auth(request(app).post(`/api/v1/meetings/${id}/speakers/split`))
      .send({ lineIndex: idx })
      .expect(200);
    expect((res.body as { newSpeaker: string }).newSpeaker).toBe('Speaker D');
    expect(await lineNames(id)).toEqual([
      'Speaker A',
      'Speaker B',
      'Speaker D',
      'Speaker C',
      'Speaker D',
    ]);
  });

  it('reassigning one line moves only that line and merges it into its new neighbours', async () => {
    const id = await seedMeeting('M', turns, cards());
    const lines = (await MeetingDataModel.findOne({ meetingId: id }).lean())!.lines;
    const idx = lines.findIndex((l) => l.textNative === 'c');
    await auth(request(app).post(`/api/v1/meetings/${id}/lines/reassign`))
      .send({ lineIndex: idx, toDiar: 'S1' })
      .expect(200);
    // a | b+c (same speaker, short pause) | d | e
    expect(await lineNames(id)).toEqual(['Speaker A', 'Speaker B', 'Speaker C', 'Speaker A']);
  });

  it('rejects edits on a meeting without pyannote speakers', async () => {
    const m = await MeetingModel.create({
      workspaceId: workspace._id,
      title: 'Old',
      audio: { originalUrl: 'x', originalPublicId: 'x' },
    });
    await MeetingDataModel.create({ meetingId: m._id });
    await auth(request(app).post(`/api/v1/meetings/${String(m._id)}/speakers/merge`))
      .send({ from: 'a', into: 'b' })
      .expect(400);
  });

  it('does not show another workspace’s meeting', async () => {
    const other = new Types.ObjectId();
    const m = await MeetingModel.create({
      workspaceId: other,
      title: 'Not yours',
      audio: { originalUrl: 'x', originalPublicId: 'x' },
    });
    await auth(request(app).get(`/api/v1/meetings/${String(m._id)}/speakers`)).expect(404);
  });
});
