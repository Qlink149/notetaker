import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Turn } from '@meetingid/shared';
import { createApp } from '../src/app.js';
import { resetEnvCache } from '../src/config/env.js';
import { knownVoices } from '../src/services/identity/enroll.js';
import { applyNames } from '../src/services/identity/identity.js';
import {
  JobModel,
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  SpeakerUndoModel,
  TaskModel,
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
  delete process.env.SPEAKER_ADMINS;
  resetEnvCache();
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

const card = (diar: string, label: string, personId: string | null): SpeakerCardDoc => ({
  diar,
  label,
  personId,
  speakerSec: 30,
  match: null,
  candidate: null,
  status: 'new',
  clips: [{ start: 0, end: 10, quality: 80 }],
});

const vp = (id: string) => ({
  id,
  source: 'meeting' as const,
  audioUrl: '',
  voiceprint: id,
  model: 'precision-2',
  createdAt: new Date(),
});

async function seedMeeting(
  title: string,
  turns: Turn[],
  cards: SpeakerCardDoc[],
  summary?: string,
): Promise<string> {
  const m = await MeetingModel.create({
    workspaceId: workspace._id,
    title,
    status: 'completed',
    stage: 'done',
    audio: { originalUrl: 'x', originalPublicId: 'x', playbackUrl: 'x' },
    summaryStatus: 'completed',
    summary: summary ?? null,
    summaryAt: summary ? new Date('2026-10-01T00:00:00.000Z') : null,
    actionItems: summary ? [{ speakerName: 'Speaker A', text: 'Send the file' }] : [],
  });
  await MeetingDataModel.create({
    meetingId: m._id,
    turns,
    speakerCards: cards,
    speakerSource: 'pyannote',
    speechSegments: [{ start: 0, end: 100 }],
  });
  await applyNames(String(m._id));
  if (summary) {
    await MeetingModel.updateOne(
      { _id: m._id },
      {
        $set: {
          summary,
          summaryStatus: 'completed',
          summaryAt: new Date('2026-10-01T00:00:00.000Z'),
          summaryOutdated: false,
          summaryNames: null,
          actionItems: [{ speakerName: 'Speaker A', text: 'Send the file' }],
        },
      },
    );
  }
  return String(m._id);
}

const lineNames = async (id: string): Promise<string[]> =>
  ((await MeetingDataModel.findOne({ meetingId: id }).lean())?.lines ?? []).map(
    (l) => l.speakerName,
  );

const setMe = (personId: string) =>
  auth(request(app).put('/api/v1/workspace/me')).send({ personId }).expect(200);

async function asHeet(): Promise<string> {
  const heet = await SpeakerModel.create({
    workspaceId: workspace._id,
    name: 'Heet',
    anonymous: false,
  });
  await setMe(String(heet._id));
  return String(heet._id);
}

describe('global speaker assign', () => {
  it('lets only the allowlisted “this is me” person assign voices', async () => {
    const placeholder = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Speaker A (Meeting Post)',
      anonymous: true,
      voiceprints: [vp('vp-a')],
    });
    const parag = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Parag',
      anonymous: false,
      email: 'parag@kisna.test',
      role: 'Sales',
    });
    const body = { personId: String(parag._id) };
    await auth(request(app).post(`/api/v1/speakers/${placeholder._id}/assign`))
      .send(body)
      .expect(403);

    const raj = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Rajender',
      anonymous: false,
    });
    await setMe(String(raj._id));
    await auth(request(app).post(`/api/v1/speakers/${placeholder._id}/assign`))
      .send(body)
      .expect(403);
    const hidden = await auth(request(app).get('/api/v1/speakers')).expect(200);
    expect(hidden.body.canAssignSpeakers).toBe(false);
    expect(hidden.body.undos).toEqual([]);

    await asHeet();
    const open = await auth(request(app).get('/api/v1/speakers')).expect(200);
    expect(open.body.canAssignSpeakers).toBe(true);
    const preview = await auth(request(app).post(`/api/v1/speakers/${placeholder._id}/assign`))
      .send(body)
      .expect(200);
    expect(preview.body.needsConfirmation).toBe(true);
    expect(preview.body.target).toMatchObject({ id: String(parag._id), email: 'parag@kisna.test' });
    expect(await SpeakerModel.exists({ _id: placeholder._id })).toBeTruthy();

    const longer = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Heet Dholakia',
      anonymous: false,
    });
    await setMe(String(longer._id));
    await auth(request(app).post(`/api/v1/speakers/${placeholder._id}/assign`))
      .send(body)
      .expect(200);

    await request(app).post(`/api/v1/speakers/${placeholder._id}/assign`).send(body).expect(401);
  });

  it('accepts a speaker id on the allowlist', async () => {
    const raj = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Rajender',
      anonymous: false,
    });
    const voice = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Speaker G (Meeting YOYO)',
      anonymous: true,
    });
    const parag = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Parag',
      anonymous: false,
    });
    process.env.SPEAKER_ADMINS = String(raj._id);
    resetEnvCache();
    await setMe(String(raj._id));
    const res = await auth(request(app).post(`/api/v1/speakers/${voice._id}/assign`))
      .send({ personId: String(parag._id) })
      .expect(200);
    expect(res.body.needsConfirmation).toBe(true);
  });

  it('refuses to assign the profile that is “this is me”', async () => {
    const heet = await asHeet();
    const parag = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Parag',
      anonymous: false,
    });
    const res = await auth(request(app).post(`/api/v1/speakers/${heet}/assign`))
      .send({ personId: String(parag._id), confirm: true })
      .expect(400);
    expect(res.body.error).toMatch(/This is me/);
    expect(await SpeakerModel.exists({ _id: heet })).toBeTruthy();
  });

  it('merges a voice into a person across past meetings, swaps the summary, and does not regenerate it', async () => {
    await asHeet();
    const placeholder = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Speaker A (Meeting Post)',
      anonymous: true,
      voiceprints: [vp('vp-a')],
    });
    const parag = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Parag',
      anonymous: false,
      email: 'parag@kisna.test',
      role: 'Sales',
      voiceprints: [vp('vp-parag')],
    });
    const post = await seedMeeting(
      'Post',
      [turn('S0', 0, 5, 'hello there')],
      [card('S0', 'Speaker A', String(placeholder._id))],
      'Speaker A opened the meeting.',
    );
    const yoyo = await seedMeeting(
      'YOYO',
      [turn('S0', 0, 5, 'hello there')],
      [card('S0', 'Speaker A', String(placeholder._id))],
      'Speaker A opened the meeting.',
    );
    const task = await TaskModel.create({
      workspaceId: workspace._id,
      title: 'Send the file',
      ownerId: placeholder._id,
    });

    const preview = await auth(request(app).post(`/api/v1/speakers/${placeholder._id}/assign`))
      .send({ personId: String(parag._id) })
      .expect(200);
    expect(preview.body).toMatchObject({
      needsConfirmation: true,
      action: 'merge',
      meetings: 2,
      undoMinutes: 10,
    });
    expect(await lineNames(post)).toEqual(['Speaker A']);
    expect(await SpeakerModel.countDocuments({ name: 'Speaker A (Meeting Post)' })).toBe(1);

    const done = await auth(request(app).post(`/api/v1/speakers/${placeholder._id}/assign`))
      .send({ personId: String(parag._id), confirm: true })
      .expect(200);
    expect(done.body.needsConfirmation).toBe(false);
    expect(done.body.undoId).toBeTruthy();

    expect(await lineNames(post)).toEqual(['Parag']);
    expect(await lineNames(yoyo)).toEqual(['Parag']);
    const cards = async (id: string) =>
      (await MeetingDataModel.findOne({ meetingId: id }).lean())?.speakerCards ?? [];
    expect((await cards(post))[0]?.personId).toBe(String(parag._id));
    expect((await cards(yoyo))[0]?.personId).toBe(String(parag._id));
    expect(await SpeakerModel.exists({ _id: placeholder._id })).toBeNull();
    const kept = await SpeakerModel.findById(parag._id).lean();
    expect(kept?.voiceprints.map((v) => v.id).sort()).toEqual(['vp-a', 'vp-parag']);
    expect(String((await TaskModel.findById(task._id).lean())?.ownerId)).toBe(String(parag._id));

    const meeting = await MeetingModel.findById(post).lean();
    expect(meeting?.summary).toBe('Parag opened the meeting.');
    expect(meeting?.actionItems?.[0]?.speakerName).toBe('Parag');
    expect(meeting?.summaryAt?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(meeting?.summaryStatus).toBe('completed');
    expect(await JobModel.countDocuments({ stage: 'summarise' })).toBe(0);

    const heard = await knownVoices(new Types.ObjectId().toString(), String(workspace._id));
    expect(Object.values(heard.labelToPerson)).toContain(String(parag._id));
    expect(Object.values(heard.labelToPerson)).not.toContain(String(placeholder._id));
    expect(heard.refs.map((r) => r.voiceprint).sort()).toEqual(['vp-a', 'vp-parag']);
  });

  it('undoes a merge inside the window and refuses it afterwards', async () => {
    await asHeet();
    const placeholder = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Speaker A (Meeting Post)',
      anonymous: true,
      voiceprints: [vp('vp-a')],
    });
    const parag = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Parag',
      anonymous: false,
      voiceprints: [vp('vp-parag')],
    });
    const post = await seedMeeting(
      'Post',
      [turn('S0', 0, 5, 'hello there')],
      [card('S0', 'Speaker A', String(placeholder._id))],
      'Speaker A opened the meeting.',
    );
    const task = await TaskModel.create({
      workspaceId: workspace._id,
      title: 'Send the file',
      ownerId: placeholder._id,
    });
    const done = await auth(request(app).post(`/api/v1/speakers/${placeholder._id}/assign`))
      .send({ personId: String(parag._id), confirm: true })
      .expect(200);

    await auth(request(app).post(`/api/v1/speakers/undo/${done.body.undoId}`)).expect(200);
    expect(await SpeakerModel.exists({ _id: placeholder._id })).toBeTruthy();
    const restored = await SpeakerModel.findById(placeholder._id).lean();
    expect(restored?.name).toBe('Speaker A (Meeting Post)');
    expect(restored?.voiceprints.map((v) => v.id)).toEqual(['vp-a']);
    const paragAgain = await SpeakerModel.findById(parag._id).lean();
    expect(paragAgain?.voiceprints.map((v) => v.id)).toEqual(['vp-parag']);
    expect(await lineNames(post)).toEqual(['Speaker A']);
    expect((await MeetingModel.findById(post).lean())?.summary).toBe(
      'Speaker A opened the meeting.',
    );
    expect(String((await TaskModel.findById(task._id).lean())?.ownerId)).toBe(
      String(placeholder._id),
    );

    await auth(request(app).post(`/api/v1/speakers/undo/${done.body.undoId}`)).expect(409);

    const again = await auth(request(app).post(`/api/v1/speakers/${placeholder._id}/assign`))
      .send({ personId: String(parag._id), confirm: true })
      .expect(200);
    await SpeakerUndoModel.updateOne(
      { _id: again.body.undoId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    await auth(request(app).post(`/api/v1/speakers/undo/${again.body.undoId}`)).expect(410);
    expect(await SpeakerModel.exists({ _id: placeholder._id })).toBeNull();
    expect(await lineNames(post)).toEqual(['Parag']);
  });

  it('assigns by person id when two people share a name', async () => {
    await asHeet();
    const voice = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Speaker G (Meeting Nikhar)',
      anonymous: true,
      voiceprints: [vp('vp-g')],
    });
    const sales = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Amit',
      anonymous: false,
      email: 'a@kisna.test',
      role: 'Sales',
      voiceprints: [vp('vp-sales')],
    });
    const ops = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Amit',
      anonymous: false,
      email: 'b@kisna.test',
      role: 'Ops',
      voiceprints: [vp('vp-ops')],
    });
    const listed = await auth(request(app).get('/api/v1/speakers')).expect(200);
    const amits = (listed.body.speakers as { id: string; name: string; email: string }[]).filter(
      (s) => s.name === 'Amit',
    );
    expect(amits.map((s) => s.email).sort()).toEqual(['a@kisna.test', 'b@kisna.test']);

    const id = await seedMeeting(
      'Nikhar',
      [turn('S0', 0, 5, 'hello there')],
      [card('S0', 'Speaker G', String(voice._id))],
    );
    await auth(request(app).post(`/api/v1/speakers/${voice._id}/assign`))
      .send({ personId: String(ops._id), confirm: true })
      .expect(200);

    const cardNow = (await MeetingDataModel.findOne({ meetingId: id }).lean())?.speakerCards[0];
    expect(cardNow?.personId).toBe(String(ops._id));
    expect(await lineNames(id)).toEqual(['Amit']);
    expect((await SpeakerModel.findById(sales._id).lean())?.voiceprints.map((v) => v.id)).toEqual([
      'vp-sales',
    ]);
    expect(
      (await SpeakerModel.findById(ops._id).lean())?.voiceprints.map((v) => v.id).sort(),
    ).toEqual(['vp-g', 'vp-ops']);
  });

  it('rejects an empty name, trims spaces, and offers a merge when the name already exists', async () => {
    await asHeet();
    const voice = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Speaker A (Meeting Post)',
      anonymous: true,
      voiceprints: [vp('vp-a')],
    });
    const sales = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Amit',
      anonymous: false,
      email: 'a@kisna.test',
      role: 'Sales',
    });
    const ops = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Amit',
      anonymous: false,
      email: 'b@kisna.test',
      role: 'Ops',
    });
    await auth(request(app).post(`/api/v1/speakers/${voice._id}/assign`))
      .send({ name: '   ', confirm: true })
      .expect(400);
    await auth(request(app).post(`/api/v1/speakers/${voice._id}/assign`))
      .send({ confirm: true })
      .expect(400);

    const clash = await auth(request(app).post(`/api/v1/speakers/${voice._id}/assign`))
      .send({ name: '  amit ', confirm: true })
      .expect(409);
    expect(clash.body.error).toBe('name_exists');
    expect(clash.body.matches.map((m: { id: string }) => m.id).sort()).toEqual(
      [String(sales._id), String(ops._id)].sort(),
    );
    expect((await SpeakerModel.findById(voice._id).lean())?.name).toBe('Speaker A (Meeting Post)');

    const fresh = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Speaker B (Meeting Post)',
      anonymous: true,
    });
    const id = await seedMeeting(
      'Post',
      [turn('S0', 0, 5, 'hello there')],
      [card('S0', 'Speaker B', String(fresh._id))],
    );
    const named = await auth(request(app).post(`/api/v1/speakers/${fresh._id}/assign`))
      .send({ name: '  Parag Shah  ', confirm: true })
      .expect(200);
    expect(named.body.action).toBe('rename');
    expect((await SpeakerModel.findById(fresh._id).lean())?.name).toBe('Parag Shah');
    expect((await SpeakerModel.findById(fresh._id).lean())?.anonymous).toBe(false);
    expect(await lineNames(id)).toEqual(['Parag Shah']);
    expect(await JobModel.countDocuments({ stage: 'summarise' })).toBe(0);

    await auth(request(app).post(`/api/v1/speakers/undo/${named.body.undoId}`)).expect(200);
    const back = await SpeakerModel.findById(fresh._id).lean();
    expect(back?.name).toBe('Speaker B (Meeting Post)');
    expect(back?.anonymous).toBe(true);
    expect(await lineNames(id)).toEqual(['Speaker B']);
  });

  it('merges two placeholder voices into one profile', async () => {
    await asHeet();
    const nikhar = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Speaker G (Meeting Nikhar)',
      anonymous: true,
      voiceprints: [vp('vp-nikhar')],
    });
    const yoyoVoice = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Speaker G (Meeting YOYO)',
      anonymous: true,
      voiceprints: [vp('vp-yoyo')],
    });
    const n = await seedMeeting(
      'Nikhar',
      [turn('S0', 0, 5, 'hello there')],
      [card('S0', 'Speaker G', String(nikhar._id))],
    );
    const y = await seedMeeting(
      'YOYO',
      [turn('S0', 0, 5, 'hello there')],
      [card('S0', 'Speaker G', String(yoyoVoice._id))],
    );
    await auth(request(app).post(`/api/v1/speakers/${yoyoVoice._id}/assign`))
      .send({ personId: String(nikhar._id), confirm: true })
      .expect(200);
    expect(await SpeakerModel.exists({ _id: yoyoVoice._id })).toBeNull();
    expect(
      (await SpeakerModel.findById(nikhar._id).lean())?.voiceprints.map((v) => v.id).sort(),
    ).toEqual(['vp-nikhar', 'vp-yoyo']);
    const personOf = async (id: string) =>
      (await MeetingDataModel.findOne({ meetingId: id }).lean())?.speakerCards[0]?.personId;
    expect(await personOf(n)).toBe(String(nikhar._id));
    expect(await personOf(y)).toBe(String(nikhar._id));
    expect(await lineNames(n)).toEqual(['Speaker G']);
    expect(await lineNames(y)).toEqual(['Speaker G']);
    const heard = await knownVoices(new Types.ObjectId().toString(), String(workspace._id));
    expect(new Set(Object.values(heard.labelToPerson))).toEqual(new Set([String(nikhar._id)]));
  });

  it('keeps a leaver’s name and shows a deleted voice as Unknown speaker', async () => {
    await asHeet();
    const left = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Parag',
      anonymous: false,
      email: 'parag@kisna.test',
      voiceprints: [vp('vp-parag')],
    });
    const gone = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Speaker A (Meeting Post)',
      anonymous: true,
      voiceprints: [vp('vp-a')],
    });
    const kept = await seedMeeting(
      'Kept',
      [turn('S0', 0, 5, 'hello there')],
      [card('S0', 'Speaker A', String(left._id))],
    );
    const dropped = await seedMeeting(
      'Dropped',
      [turn('S0', 0, 5, 'hello there')],
      [card('S0', 'Speaker A', String(gone._id))],
    );

    await auth(request(app).post(`/api/v1/speakers/${left._id}/leave`)).expect(200);
    expect(await lineNames(kept)).toEqual(['Parag']);
    expect((await SpeakerModel.findById(left._id).lean())?.leftAt).toBeTruthy();
    const heard = await knownVoices(new Types.ObjectId().toString(), String(workspace._id));
    expect(Object.values(heard.labelToPerson)).not.toContain(String(left._id));

    await auth(request(app).post(`/api/v1/speakers/${gone._id}/leave`)).expect(400);
    await auth(request(app).delete(`/api/v1/speakers/${gone._id}`)).expect(204);
    expect(await lineNames(dropped)).toEqual(['Unknown speaker']);
    const view = await auth(request(app).get(`/api/v1/meetings/${dropped}/speakers`)).expect(200);
    expect(view.body.cards[0]).toMatchObject({ personId: null, displayName: 'Unknown speaker' });
    expect(await lineNames(kept)).toEqual(['Parag']);
  });
});
