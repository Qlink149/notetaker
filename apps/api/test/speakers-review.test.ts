import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Turn } from '@meetingid/shared';
import { createApp } from '../src/app.js';
import type { NameResolution } from '@meetingid/pipeline';
import { applyNames, pyannoteSegments } from '../src/services/identity/identity.js';
import {
  cardCandidate,
  decidedCards,
  DEFAULT_THRESHOLDS,
  POSSIBLE_MIN_SCORE,
} from '../src/services/identity/enroll.js';
import {
  JobModel,
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  type SpeakerCardDoc,
  type WorkspaceDoc,
} from '../src/models/index.js';
import { LoudnessModel, ParticipantModel, SessionModel } from '../src/models/session.js';
import { P2PyannoteResponseModel } from '../src/models/phase2.js';
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
    // the other meeting's card says who it matched by the person's new name
    const aomView = (await auth(request(app).get(`/api/v1/meetings/${b}/speakers`)).expect(200))
      .body as {
      cards: { diar: string; match: { name: string } | null }[];
    };
    expect(aomView.cards.find((c) => c.diar === 'S5')!.match!.name).toBe('Ghanshyam Dholakia');
  });

  it('marks the summary of every meeting whose speaker names changed as out of date', async () => {
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
      [card('S4', 'Speaker A', null), card('S5', 'Speaker C', pid)],
    );
    const other = await seedMeeting(
      'Unrelated',
      [turn('S0', 0, 5, 'five'), turn('S1', 5, 10, 'six')],
      [card('S0', 'Speaker A', null), card('S1', 'Speaker B', null)],
    );
    await MeetingModel.updateMany(
      { _id: { $in: [a, b, other] } },
      { $set: { summary: 'Speaker B said something.', summaryStatus: 'completed' } },
    );
    const flag = async (id: string) =>
      (await auth(request(app).get(`/api/v1/meetings/${id}`)).expect(200)).body.meeting
        .summaryOutdated as boolean;
    expect([await flag(a), await flag(b), await flag(other)]).toEqual([false, false, false]);

    await auth(request(app).post(`/api/v1/meetings/${a}/speakers/S1/name`))
      .send({ name: 'Ghanshyam Dholakia' })
      .expect(200);

    // both meetings that show the voice are flagged, the unrelated one is not
    expect([await flag(a), await flag(b), await flag(other)]).toEqual([true, true, false]);

    // writing the summary again clears the flag
    await MeetingModel.updateOne({ _id: a }, { $set: { summaryOutdated: false } });
    expect(await flag(a)).toBe(false);
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

describe('correcting a wrong voice match (16 Oct: Paresh matched as Yogansh at 62)', () => {
  /** Yogansh, known from an earlier meeting, wrongly matched in a new one that taught him its clip. */
  async function wrongMatch() {
    const yogansh = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Yogansh',
      anonymous: false,
    });
    const old = await seedMeeting(
      'Team call',
      [turn('S0', 0, 5, 'hello')],
      [card('S0', 'Speaker A', String(yogansh._id), { status: 'solid', confirmed: true })],
    );
    const dv = await seedMeeting(
      'Google DV',
      [turn('S0', 0, 5, 'plan'), turn('S1', 5, 10, 'budget')],
      [
        card('S0', 'Speaker A', null),
        card('S1', 'Speaker D', String(yogansh._id), {
          status: 'solid',
          match: { personId: String(yogansh._id), name: 'Yogansh', score: 62, margin: 22 },
          clips: [{ start: 3153, end: 3161, quality: 80 }],
        }),
      ],
    );
    await SpeakerModel.updateOne(
      { _id: yogansh._id },
      {
        $set: {
          voiceprints: [
            {
              id: 'own',
              source: 'meeting',
              audioUrl: '',
              voiceprint: 'vp-yogansh',
              meetingId: new Types.ObjectId(old),
              clip: { start: 0, end: 10 },
            },
            {
              id: 'learned',
              source: 'meeting',
              audioUrl: '',
              voiceprint: 'vp-paresh',
              meetingId: new Types.ObjectId(dv),
              clip: { start: 3153.03, end: 3161.45 },
            },
          ],
        },
      },
    );
    return { yogansh: String(yogansh._id), old, dv };
  }

  it('typing the right name fixes this meeting only and keeps the matched person everywhere else', async () => {
    const { yogansh, old, dv } = await wrongMatch();
    await auth(request(app).post(`/api/v1/meetings/${dv}/speakers/S1/name`))
      .send({ name: 'Paresh Ecom' })
      .expect(200);

    expect(await lineNames(dv)).toEqual(['Speaker A', 'Paresh Ecom']);
    expect(await lineNames(old)).toEqual(['Yogansh']);
    const y = await SpeakerModel.findById(yogansh).lean();
    expect(y!.name).toBe('Yogansh');
    // the clip the wrong match taught Yogansh is taken back
    expect(y!.voiceprints.map((v) => v.id)).toEqual(['own']);
    const paresh = await SpeakerModel.findOne({ name: 'Paresh Ecom' }).lean();
    expect(String(paresh!._id)).not.toBe(yogansh);
    const view = (await auth(request(app).get(`/api/v1/meetings/${dv}/speakers`)).expect(200))
      .body as {
      cards: { diar: string; match: unknown; confirmed: boolean }[];
    };
    expect(view.cards.find((c) => c.diar === 'S1')).toMatchObject({ match: null, confirmed: true });
    // the confirmed voice is learned by the worker
    expect(
      await JobModel.countDocuments({ meetingId: dv, stage: 'learnvoice', status: 'queued' }),
    ).toBe(1);
  });

  it('linking the voice to another existing person does not merge the two people', async () => {
    const { yogansh, old, dv } = await wrongMatch();
    const paresh = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Paresh Ecom',
      anonymous: false,
    });
    await auth(request(app).post(`/api/v1/meetings/${dv}/speakers/S1/name`))
      .send({ name: 'Paresh', usePersonId: String(paresh._id) })
      .expect(200);

    expect(await lineNames(dv)).toEqual(['Speaker A', 'Paresh Ecom']);
    expect(await lineNames(old)).toEqual(['Yogansh']);
    expect(await SpeakerModel.exists({ _id: yogansh })).toBeTruthy();
    expect((await SpeakerModel.findById(yogansh).lean())!.voiceprints).toHaveLength(1);
    expect((await SpeakerModel.findById(paresh._id).lean())!.voiceprints).toHaveLength(0);
  });

  it('renames the person everywhere only when asked to', async () => {
    const { old, dv } = await wrongMatch();
    await auth(request(app).post(`/api/v1/meetings/${dv}/speakers/S1/name`))
      .send({ name: 'Yogansh Bhatt', renameEverywhere: true })
      .expect(200);
    expect(await lineNames(dv)).toEqual(['Speaker A', 'Yogansh Bhatt']);
    expect(await lineNames(old)).toEqual(['Yogansh Bhatt']);
  });

  it('confirming a match keeps the person and queues learning the voice', async () => {
    const { yogansh, dv } = await wrongMatch();
    await auth(request(app).post(`/api/v1/meetings/${dv}/speakers/S1/name`))
      .send({ name: 'Yogansh', usePersonId: yogansh })
      .expect(200);
    const data = await MeetingDataModel.findOne({ meetingId: dv }).lean();
    const c = (data!.speakerCards as SpeakerCardDoc[]).find((x) => x.diar === 'S1')!;
    expect(c).toMatchObject({ personId: yogansh, confirmed: true, status: 'solid' });
    expect(c.match).toMatchObject({ personId: yogansh, score: 62 });
    expect(await JobModel.countDocuments({ meetingId: dv, stage: 'learnvoice' })).toBe(1);
  });

  it('typing the same name again confirms instead of creating a second person', async () => {
    const { yogansh, dv } = await wrongMatch();
    await auth(request(app).post(`/api/v1/meetings/${dv}/speakers/S1/name`))
      .send({ name: ' yogansh ' })
      .expect(200);
    expect(await SpeakerModel.countDocuments({ workspaceId: workspace._id })).toBe(1);
    const data = await MeetingDataModel.findOne({ meetingId: dv }).lean();
    expect((data!.speakerCards as SpeakerCardDoc[]).find((x) => x.diar === 'S1')).toMatchObject({
      personId: yogansh,
      confirmed: true,
    });
  });
});

describe('closest known voice on a card', () => {
  const res = (over: Partial<NameResolution>): NameResolution => ({
    personId: null,
    name: 'Unknown 1',
    score: 0,
    margin: 0,
    candidate: 'Paresh Ecom',
    candidateId: 'p1',
    candidateScore: 0,
    status: 'below-threshold',
    ...over,
  });

  it('offers a near miss (60 to 74) for confirmation, and only shows weaker ones', () => {
    expect(cardCandidate(res({ score: 62, candidateScore: 62 }))).toEqual({
      name: 'Paresh Ecom',
      personId: 'p1',
      score: 62,
      status: 'possible',
    });
    expect(cardCandidate(res({ score: 54, candidateScore: 54 }))?.status).toBe('below-threshold');
    expect(cardCandidate(res({ score: 27, candidateScore: 71, status: 'taken' }))).toMatchObject({
      score: 71,
      status: 'taken',
    });
    expect(cardCandidate(res({ candidate: null }))).toBeNull();
    expect(cardCandidate(undefined)).toBeNull();
  });

  it('names a voice automatically only at 75 or more', () => {
    expect(DEFAULT_THRESHOLDS.minScore).toBe(75);
    expect(POSSIBLE_MIN_SCORE).toBe(60);
  });
});

describe('deleting a meeting (19 Oct: a test upload left 4 voice profiles behind)', () => {
  it('removes everything made from it, and only that', async () => {
    const vp = (meetingId: string, start: number) => ({
      id: `v${start}`,
      source: 'meeting' as const,
      audioUrl: '',
      voiceprint: 'vp',
      meetingId: new Types.ObjectId(meetingId),
      clip: { start, end: start + 10 },
    });
    const other = await seedMeeting('Other', [turn('S0', 0, 5, 'x')], []);
    const test = await seedMeeting('Test', [turn('S0', 0, 5, 'y')], []);
    const t = new Types.ObjectId(test);
    // first heard in the test meeting, nowhere else: removed
    const anon = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Speaker E (Meeting Test)',
      anonymous: true,
      origin: { meetingId: t, diar: 'S0' },
      voiceprints: [vp(test, 1)],
    });
    const namedHere = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Brijesh',
      anonymous: false,
      origin: { meetingId: t, diar: 'S1' },
      voiceprints: [vp(test, 2)],
    });
    // first heard here but also in another meeting: stays, loses this meeting's clip
    const alsoElsewhere = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Kanak',
      anonymous: false,
      origin: { meetingId: t, diar: 'S2' },
      voiceprints: [vp(test, 3)],
    });
    // known from before, learned a clip here: stays, loses that clip only
    const heet = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Heet',
      anonymous: false,
      voiceprints: [vp(other, 4), vp(test, 5)],
    });
    await MeetingDataModel.updateOne(
      { meetingId: other },
      { $set: { speakerCards: [card('S0', 'Speaker A', String(alsoElsewhere._id))] } },
    );
    await MeetingDataModel.updateOne(
      { meetingId: test },
      {
        $set: {
          speakerCards: [
            card('S0', 'Speaker E', String(anon._id)),
            card('S1', 'Speaker F', String(namedHere._id)),
          ],
        },
      },
    );
    await P2PyannoteResponseModel.create({
      meetingId: t,
      kind: 'diarize',
      model: 'precision-2',
      tag: 'pipeline',
      status: 'succeeded',
      jobId: 'j',
      keyLabel: 'PYANNOTEAI_API_KEY',
      submittedAt: new Date(),
      output: {},
    });

    await auth(request(app).delete(`/api/v1/meetings/${test}`)).expect(204);

    expect(await MeetingModel.exists({ _id: test })).toBeNull();
    expect(await MeetingDataModel.exists({ meetingId: test })).toBeNull();
    expect(await P2PyannoteResponseModel.countDocuments({ meetingId: t })).toBe(0);
    const left = await SpeakerModel.find({ workspaceId: workspace._id }).lean();
    expect(left.map((p) => p.name).sort()).toEqual(['Heet', 'Kanak']);
    expect(left.find((p) => p.name === 'Heet')!.voiceprints.map((v) => v.id)).toEqual(['v4']);
    expect(left.find((p) => p.name === 'Kanak')!.voiceprints).toEqual([]);
    // the other meeting is untouched: its speaker still points at Kanak
    const otherData = await MeetingDataModel.findOne({ meetingId: other }).lean();
    expect((otherData!.speakerCards as SpeakerCardDoc[])[0]!.personId).toBe(
      String(alsoElsewhere._id),
    );
    expect(await SpeakerModel.exists({ _id: heet._id })).toBeTruthy();
  });
});

describe('safety of naming and splitting', () => {
  it('rejects a person that is not an id, not in this workspace, or does not exist', async () => {
    const other = await SpeakerModel.create({
      workspaceId: new Types.ObjectId(),
      name: 'Somebody Else',
      anonymous: false,
    });
    const mine = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Speaker A (Meeting M)',
      anonymous: true,
    });
    const id = await seedMeeting(
      'M',
      [turn('S0', 0, 5, 'x')],
      [card('S0', 'Speaker A', String(mine._id))],
    );
    const name = (usePersonId: string) =>
      auth(request(app).post(`/api/v1/meetings/${id}/speakers/S0/name`)).send({
        name: 'Rajesh',
        usePersonId,
      });
    await name('abc').expect(400);
    await name(String(new Types.ObjectId())).expect(400);
    await name(String(other._id)).expect(400);
    // nothing was changed or merged away
    expect(await SpeakerModel.exists({ _id: mine._id })).toBeTruthy();
    expect(await SpeakerModel.exists({ _id: other._id })).toBeTruthy();
    await auth(request(app).get(`/api/v1/meetings/${id}/speakers`)).expect(200);
  });

  it('keeps split speakers distinct even after a merge frees a number', async () => {
    const turns = [
      turn('S0', 0, 4, 'a'),
      turn('S1', 4, 8, 'b'),
      turn('S2', 8, 12, 'c'),
      turn('S0', 20, 24, 'd'),
      turn('S0', 40, 44, 'e'),
    ];
    const id = await seedMeeting('M', turns, [
      card('S0', 'Speaker A', null),
      card('S1', 'Speaker B', null),
      card('S2', 'Speaker C', null),
    ]);
    const lineAt = async (start: number) =>
      (await MeetingDataModel.findOne({ meetingId: id }).lean())!.lines.findIndex(
        (l) => l.start >= start,
      );
    await auth(request(app).post(`/api/v1/meetings/${id}/speakers/split`))
      .send({ lineIndex: await lineAt(40) })
      .expect(200);
    await auth(request(app).post(`/api/v1/meetings/${id}/speakers/merge`))
      .send({ from: 'S2', into: 'S1' })
      .expect(200);
    await auth(request(app).post(`/api/v1/meetings/${id}/speakers/split`))
      .send({ lineIndex: await lineAt(20) })
      .expect(200);
    const diars = (await speakers(id)).cards.map((c) => c.diar);
    expect(new Set(diars).size).toBe(diars.length);
  });

  it('a deleted person leaves no card pointing at nothing, and the voice can be named again', async () => {
    const p = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Speaker A (Meeting M)',
      anonymous: true,
    });
    const id = await seedMeeting(
      'M',
      [turn('S0', 0, 5, 'x')],
      [card('S0', 'Speaker A', String(p._id))],
    );
    await auth(request(app).delete(`/api/v1/speakers/${String(p._id)}`)).expect(204);
    expect((await speakers(id)).cards[0]!.personId).toBeNull();
    await auth(request(app).post(`/api/v1/meetings/${id}/speakers/S0/name`))
      .send({ name: 'Rajesh Patel' })
      .expect(200);
    expect(await lineNames(id)).toEqual(['Rajesh Patel']);
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

  it('keeps a merge with the meeting so processing it again does not undo it (200 planning, 19 Oct)', async () => {
    const id = await seedMeeting('M', turns, cards());
    await auth(request(app).post(`/api/v1/meetings/${id}/speakers/merge`))
      .send({ from: 'S1', into: 'S0' })
      .expect(200);
    const data = await MeetingDataModel.findOne({ meetingId: id }).lean();
    expect(data!.speakerMerges).toEqual([
      expect.objectContaining({ from: 'S1', into: 'S0', manual: true }),
    ]);
    // a rebuild reads the pyannote speakers with the stored merges applied: S1 is gone
    await P2PyannoteResponseModel.create({
      meetingId: id,
      kind: 'diarize',
      model: 'precision-2',
      tag: 'pipeline',
      status: 'succeeded',
      jobId: 'j1',
      keyLabel: 'PYANNOTEAI_API_KEY',
      submittedAt: new Date(),
      output: {
        diarization: [
          { speaker: 'S0', start: 0, end: 4 },
          { speaker: 'S1', start: 4, end: 8 },
          { speaker: 'S2', start: 12, end: 16 },
        ],
      },
    });
    const pya = await pyannoteSegments(id);
    expect([...new Set(pya!.segments.map((s) => s.speaker))].sort()).toEqual(['S0', 'S2']);
    // and the page does not call it an automatic merge
    const view = (await auth(request(app).get(`/api/v1/meetings/${id}/speakers`)).expect(200))
      .body as { autoMerged: unknown[] };
    expect(view.autoMerged).toEqual([]);
  });

  it('a voice a person decided keeps that decision when identified again', async () => {
    const named = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Brijesh Dholakia',
      anonymous: false,
    });
    const gone = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Old',
      anonymous: false,
    });
    const id = await seedMeeting('M', turns, [
      card('S0', 'Speaker A', String(named._id), { status: 'solid', confirmed: true }),
      card('S1', 'Speaker B', null, { status: 'manual' }),
      card('S2', 'Speaker C', String(gone._id), { status: 'solid', confirmed: true }),
    ]);
    await SpeakerModel.deleteOne({ _id: gone._id });
    await MeetingDataModel.updateOne(
      { meetingId: id },
      { $push: { speakerCards: card('S3', 'Speaker D', null, { status: 'solid' }) } },
    );
    const kept = await decidedCards(id);
    // confirmed and hand-edited voices are kept; an untouched one and one whose person was deleted are not
    expect([...kept.keys()].sort()).toEqual(['S0', 'S1']);
    expect(kept.get('S0')).toMatchObject({ personId: String(named._id), confirmed: true });
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

describe('closest phone hint (group recordings)', () => {
  it('shows which phone was loudest for a voice, and only as a hint', async () => {
    const id = await seedMeeting(
      'Group',
      [turn('S0', 0, 5, 'one'), turn('S1', 5, 10, 'two')],
      [card('S0', 'Speaker A', null), card('S1', 'Speaker B', null)],
    );
    const segs = [
      { speaker: 'S0', start: 0, end: 5 },
      { speaker: 'S1', start: 5, end: 10 },
    ];
    await P2PyannoteResponseModel.create({
      meetingId: id,
      kind: 'diarize',
      model: 'precision-2',
      tag: 'pipeline',
      jobId: 'j1',
      status: 'succeeded',
      submittedAt: new Date(),
      output: { diarization: segs, exclusiveDiarization: segs },
      keyLabel: 'PYANNOTEAI_API_KEY',
    });
    const session = await SessionModel.create({
      workspaceId: workspace._id,
      code: 'ABC234',
      folder: 'f',
      meetingId: id,
      state: 'done',
    });
    const anil = await ParticipantModel.create({
      sessionId: session._id,
      name: 'Anil',
      token: 't1',
    });
    const bina = await ParticipantModel.create({
      sessionId: session._id,
      name: 'Bina',
      token: 't2',
    });
    // 40 hops of 250 ms: Anil's phone is loud for the first 5 s, Bina's for the next 5 s
    const hops = (a: number, b: number) => Array.from({ length: 40 }, (_, i) => (i < 20 ? a : b));
    await LoudnessModel.create({
      sessionId: session._id,
      participantId: anil._id,
      hopSec: 0.25,
      db: hops(-18, -40),
    });
    await LoudnessModel.create({
      sessionId: session._id,
      participantId: bina._id,
      hopSec: 0.25,
      db: hops(-40, -18),
    });

    const view = await speakers(id);
    const byDiar = Object.fromEntries(
      (
        view.cards as unknown as {
          diar: string;
          phone: { name: string; attributed: number; total: number } | null;
          displayName: string;
        }[]
      ).map((c) => [c.diar, c]),
    );
    expect(byDiar['S0']!.phone).toEqual({ name: 'Anil', attributed: 1, total: 1 });
    expect(byDiar['S1']!.phone).toEqual({ name: 'Bina', attributed: 1, total: 1 });
    // the hint does not name anyone
    expect(byDiar['S0']!.displayName).toBe('Speaker A');
  });
});

import { shortTitle } from '../src/services/identity/identity.js';
describe('shortTitle', () => {
  it('keeps one word, skips a generic first word, and reads dates', () => {
    expect(shortTitle('AOM Meeting part 1 (acceptance)')).toBe('AOM');
    expect(shortTitle('Meeting 8 Oct (WhatsApp audio)')).toBe('8 Oct');
    expect(shortTitle('Meeting-21-9-2026')).toBe('21/9');
    expect(shortTitle('Meeting')).toBe('Meeting');
  });
});
