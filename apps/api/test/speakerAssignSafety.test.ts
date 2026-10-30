import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import type { Turn } from '@meetingid/shared';
import { createApp } from '../src/app.js';
import { resetEnvCache } from '../src/config/env.js';
import * as edits from '../src/services/identity/edits.js';
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
  type SpeakerDoc,
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
  process.env.SPEAKER_ASSIGN = 'true';
  resetEnvCache();
  await clearDb();
  workspace = await seedWorkspace();
  const res = await request(app).post('/api/v1/auth/login').send({ code: ACCESS_CODE });
  token = res.body.token as string;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env.SPEAKER_ASSIGN = 'true';
  resetEnvCache();
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
const cardOf = async (id: string) =>
  (await MeetingDataModel.findOne({ meetingId: id }).lean())?.speakerCards[0];
const person = (name: string, extra: Partial<SpeakerDoc> = {}) =>
  SpeakerModel.create({ workspaceId: workspace._id, name, anonymous: false, ...extra });
const voice = (name: string, id: string) =>
  SpeakerModel.create({
    workspaceId: workspace._id,
    name,
    anonymous: true,
    voiceprints: [vp(id)],
  });
const fresh = (id: Types.ObjectId) => SpeakerModel.findById(id).lean<SpeakerDoc>();

async function asHeet(): Promise<string> {
  const heet = await person('Heet');
  await auth(request(app).put('/api/v1/workspace/me')).send({ personId: String(heet._id) });
  return String(heet._id);
}
const assign = (from: Types.ObjectId, body: object) =>
  auth(request(app).post(`/api/v1/speakers/${from}/assign`)).send(body);
const merge = (from: Types.ObjectId, into: Types.ObjectId) =>
  assign(from, { personId: String(into), confirm: true });
const undo = (id: string) => auth(request(app).post(`/api/v1/speakers/undo/${id}`));

describe('startup: the speaker name index stays as the live database has it', () => {
  it('is still unique, so building indexes on the live database cannot conflict', () => {
    const idx = SpeakerModel.schema
      .indexes()
      .find(([keys]) => JSON.stringify(keys) === JSON.stringify({ workspaceId: 1, name: 1 }));
    expect(idx?.[1]).toMatchObject({ unique: true });
  });

  it('builds on a database that already has that unique index, again and again', async () => {
    await SpeakerModel.createIndexes();
    await SpeakerModel.createIndexes();
    await SpeakerUndoModel.createIndexes();
    const idx = await SpeakerUndoModel.collection.indexes();
    expect(idx.find((i) => i.key?.expiresAt === 1)?.expireAfterSeconds).toBe(24 * 60 * 60);
  });
});

describe('undo puts back what the change added, and nothing else', () => {
  it('keeps a voice learned onto the person since the merge, and a changed name', async () => {
    await asHeet();
    const from = await voice('Speaker A (Meeting Post)', 'vp-a');
    const into = await person('Parag', { voiceprints: [vp('vp-parag')] });
    const id = await seedMeeting(
      'Post',
      [turn('S0', 0, 5, 'hello there')],
      [card('S0', 'Speaker A', String(from._id))],
    );
    const done = await merge(from._id, into._id).expect(200);
    // a voice learned and a name fixed while the window is open
    await SpeakerModel.updateOne({ _id: into._id }, { $push: { voiceprints: vp('vp-learned') } });
    await SpeakerModel.updateOne({ _id: into._id }, { $set: { name: 'Parag Shah' } });
    await undo(done.body.undoId).expect(200);
    const back = (await fresh(into._id))!;
    expect(back.voiceprints.map((v) => v.id).sort()).toEqual(['vp-learned', 'vp-parag']);
    expect(back.name).toBe('Parag Shah');
    expect(back.aliases).not.toContain('Speaker A (Meeting Post)');
    expect((await fresh(from._id))!.voiceprints.map((v) => v.id)).toEqual(['vp-a']);
    expect((await cardOf(id))?.personId).toBe(String(from._id));
    expect(await lineNames(id)).toEqual(['Speaker A']);
  });

  it('takes away the alias, and the ignored meetings, that the merge added', async () => {
    await asHeet();
    const m1 = new Types.ObjectId();
    const from = await person('Ghanshyambhai', { voiceprints: [vp('vp-g')], ignoreMeetings: [m1] });
    const into = await person('Ghanshyam Dholakia', { voiceprints: [vp('vp-gd')] });
    const done = await merge(from._id, into._id).expect(200);
    const merged = (await fresh(into._id))!;
    expect(merged.aliases).toContain('Ghanshyambhai');
    expect(merged.ignoreMeetings.map(String)).toEqual([String(m1)]);
    await undo(done.body.undoId).expect(200);
    const back = (await fresh(into._id))!;
    expect(back.aliases).toEqual([]);
    expect(back.ignoreMeetings).toEqual([]);
    expect(back.voiceprints.map((v) => v.id)).toEqual(['vp-gd']);
    const source = (await fresh(from._id))!;
    expect(source.name).toBe('Ghanshyambhai');
    expect(source.ignoreMeetings.map(String)).toEqual([String(m1)]);
  });

  it('lets go of the voice pin the merge made, unless the voice was chosen again since', async () => {
    await asHeet();
    const from = await voice('Speaker A (Meeting Post)', 'vp-a');
    const into = await person('Parag', { voiceprints: [vp('vp-parag')] });
    const done = await merge(from._id, into._id).expect(200);
    // the merge pinned Parag's own sample so the one that joined cannot take its place
    expect((await fresh(into._id))!.mainSampleId).toBe('vp-parag');
    await undo(done.body.undoId).expect(200);
    expect((await fresh(into._id))!.mainSampleId ?? null).toBeNull();

    const from2 = await voice('Speaker B (Meeting Post)', 'vp-b');
    const into2 = await person('Amit', { voiceprints: [vp('vp-amit'), vp('vp-amit2')] });
    const done2 = await merge(from2._id, into2._id).expect(200);
    await SpeakerModel.updateOne({ _id: into2._id }, { $set: { mainSampleId: 'vp-amit2' } });
    await undo(done2.body.undoId).expect(200);
    expect((await fresh(into2._id))!.mainSampleId).toBe('vp-amit2');
  });

  it('does not touch a card, task or "me" that has been changed since', async () => {
    const heet = await asHeet();
    const from = await voice('Speaker A (Meeting Post)', 'vp-a');
    const into = await person('Parag', { voiceprints: [vp('vp-parag')] });
    const other = await person('Amit');
    const id = await seedMeeting(
      'Post',
      [turn('S0', 0, 5, 'hello there')],
      [card('S0', 'Speaker A', String(from._id))],
    );
    const task = await TaskModel.create({
      workspaceId: workspace._id,
      title: 'Send',
      ownerId: from._id,
    });
    const done = await merge(from._id, into._id).expect(200);
    // someone gives the card and the task to Amit meanwhile
    await MeetingDataModel.updateOne(
      { meetingId: id },
      { $set: { 'speakerCards.0.personId': String(other._id) } },
    );
    await TaskModel.updateOne({ _id: task._id }, { $set: { ownerId: other._id } });
    await undo(done.body.undoId).expect(200);
    expect((await cardOf(id))?.personId).toBe(String(other._id));
    expect(String((await TaskModel.findById(task._id).lean())?.ownerId)).toBe(String(other._id));
    void heet;
  });

  it('refuses the older undo while a newer change to the same person is open', async () => {
    await asHeet();
    const x = await voice('Speaker X', 'vp-x');
    const z = await voice('Speaker Z', 'vp-z');
    const y = await person('Yash', { voiceprints: [vp('vp-y')] });
    const first = await merge(x._id, y._id).expect(200);
    const second = await merge(z._id, y._id).expect(200);
    const late = await undo(first.body.undoId).expect(409);
    expect(late.body.error).toBe('undo_newer_change');
    // nothing was written by the refused undo
    expect((await fresh(y._id))!.voiceprints.map((v) => v.id).sort()).toEqual(['vp-x', 'vp-y', 'vp-z']);
    expect(await SpeakerModel.exists({ _id: x._id })).toBeNull();
    // newest first works, then the older one
    await undo(second.body.undoId).expect(200);
    await undo(first.body.undoId).expect(200);
    expect((await fresh(y._id))!.voiceprints.map((v) => v.id)).toEqual(['vp-y']);
    expect((await fresh(x._id))!.voiceprints.map((v) => v.id)).toEqual(['vp-x']);
    expect((await fresh(z._id))!.voiceprints.map((v) => v.id)).toEqual(['vp-z']);
  });

  it('refuses a rename undo when the name was changed again, or taken by someone else', async () => {
    await asHeet();
    const a = await voice('Speaker A (Meeting Post)', 'vp-a');
    const named = await assign(a._id, { name: 'Parag Shah', confirm: true }).expect(200);
    await SpeakerModel.updateOne({ _id: a._id }, { $set: { name: 'Parag S.' } });
    expect((await undo(named.body.undoId).expect(409)).body.error).toMatch(/changed again/);
    expect((await fresh(a._id))!.name).toBe('Parag S.');

    const b = await voice('Speaker B (Meeting Post)', 'vp-b');
    const named2 = await assign(b._id, { name: 'Amit Rao', confirm: true }).expect(200);
    await person('Speaker B (Meeting Post)');
    expect((await undo(named2.body.undoId).expect(409)).body.error).toMatch(/Someone else/);
    expect((await fresh(b._id))!.name).toBe('Amit Rao');
  });

  it('keeps a summary that was written again during the window', async () => {
    await asHeet();
    const from = await voice('Speaker A (Meeting Post)', 'vp-a');
    const into = await person('Parag', { voiceprints: [vp('vp-parag')] });
    const id = await seedMeeting(
      'Post',
      [turn('S0', 0, 5, 'hello there')],
      [card('S0', 'Speaker A', String(from._id))],
      'Speaker A opened the meeting.',
    );
    const done = await merge(from._id, into._id).expect(200);
    await MeetingModel.updateOne(
      { _id: id },
      { $set: { summary: 'A brand new summary.', summaryAt: new Date('2026-10-02T00:00:00.000Z') } },
    );
    await undo(done.body.undoId).expect(200);
    expect((await MeetingModel.findById(id).lean())?.summary).toBe('A brand new summary.');
  });

  it('puts a task that followed the summary back, including one that was dropped', async () => {
    await asHeet();
    const from = await voice('Speaker A (Meeting Post)', 'vp-a');
    const into = await person('Parag', { voiceprints: [vp('vp-parag')] });
    const id = await seedMeeting(
      'Post',
      [turn('S0', 0, 5, 'hello there')],
      [card('S0', 'Speaker A', String(from._id))],
      'Speaker A opened the meeting.',
    );
    const kept = await TaskModel.create({
      workspaceId: workspace._id,
      meetingId: id,
      title: 'Send the file',
      ownerId: from._id,
      source: { index: 0, text: 'Send the file' },
    });
    const done = await merge(from._id, into._id).expect(200);
    // the task is dropped as the follow-up would (the owner is gone from the meeting)
    await TaskModel.deleteOne({ _id: kept._id });
    await undo(done.body.undoId).expect(200);
    const back = await TaskModel.findById(kept._id).lean();
    expect(back?.title).toBe('Send the file');
    expect(String(back?.ownerId)).toBe(String(from._id));
  });
});

describe('a merge that stops halfway is put back, and the undo record is written first', () => {
  it('rolls back and removes its record when the merge throws after writing', async () => {
    await asHeet();
    const from = await voice('Speaker A (Meeting Post)', 'vp-a');
    const into = await person('Parag', { voiceprints: [vp('vp-parag')] });
    const id = await seedMeeting(
      'Post',
      [turn('S0', 0, 5, 'hello there')],
      [card('S0', 'Speaker A', String(from._id))],
    );
    const real = edits.mergePeople;
    vi.spyOn(edits, 'mergePeople').mockImplementationOnce(async (keep, drop) => {
      await real(keep, drop);
      throw new Error('boom');
    });
    await merge(from._id, into._id).expect(500);
    expect((await fresh(into._id))!.voiceprints.map((v) => v.id)).toEqual(['vp-parag']);
    expect((await fresh(from._id))!.voiceprints.map((v) => v.id)).toEqual(['vp-a']);
    expect((await cardOf(id))?.personId).toBe(String(from._id));
    expect(await lineNames(id)).toEqual(['Speaker A']);
    expect(await SpeakerUndoModel.countDocuments({})).toBe(0);
  });

  it('writes the undo record before it merges', async () => {
    await asHeet();
    const from = await voice('Speaker A (Meeting Post)', 'vp-a');
    const into = await person('Parag', { voiceprints: [vp('vp-parag')] });
    let seen = -1;
    const real = edits.mergePeople;
    vi.spyOn(edits, 'mergePeople').mockImplementationOnce(async (keep, drop) => {
      seen = await SpeakerUndoModel.countDocuments({});
      return real(keep, drop);
    });
    await merge(from._id, into._id).expect(200);
    expect(seen).toBe(1);
  });
});

describe('merging, deleting and undoing wait while a meeting is being processed', () => {
  const job = (status: 'queued' | 'running' | 'done') =>
    JobModel.create({ meetingId: new Types.ObjectId(), stage: 'identify', status });

  it('refuses a confirmed merge, a delete and an undo, but still shows the preview', async () => {
    await asHeet();
    const from = await voice('Speaker A (Meeting Post)', 'vp-a');
    const into = await person('Parag', { voiceprints: [vp('vp-parag')] });
    const done = await merge(from._id, into._id).expect(200);
    const another = await voice('Speaker B (Meeting Post)', 'vp-b');
    const j = await job('running');
    const preview = await assign(another._id, { personId: String(into._id) }).expect(200);
    expect(preview.body.needsConfirmation).toBe(true);
    const busy = await merge(another._id, into._id).expect(409);
    expect(busy.body.error).toMatch(/being processed/);
    await auth(request(app).delete(`/api/v1/speakers/${another._id}`)).expect(409);
    await undo(done.body.undoId).expect(409);
    expect(await SpeakerModel.exists({ _id: another._id })).toBeTruthy();
    await JobModel.updateOne({ _id: j._id }, { $set: { status: 'done' } });
    await merge(another._id, into._id).expect(200);
  });

  it('refuses a confirmed rename too, and shows the preview', async () => {
    await asHeet();
    const a = await voice('Speaker A (Meeting Post)', 'vp-a');
    await job('queued');
    await assign(a._id, { name: 'Parag Shah' }).expect(200);
    await assign(a._id, { name: 'Parag Shah', confirm: true }).expect(409);
    expect((await fresh(a._id))!.name).toBe('Speaker A (Meeting Post)');
    expect(await SpeakerUndoModel.countDocuments({})).toBe(0);
  });

  it('is not held up by finished jobs', async () => {
    await asHeet();
    const from = await voice('Speaker A (Meeting Post)', 'vp-a');
    const into = await person('Parag');
    await job('done');
    await merge(from._id, into._id).expect(200);
  });
});

describe('a deleted voice', () => {
  it('is not a participant, and counts as unknown', async () => {
    await asHeet();
    const gone = await voice('Speaker A (Meeting Post)', 'vp-a');
    const kept = await person('Parag');
    const id = await seedMeeting(
      'Post',
      [turn('S0', 0, 5, 'hello there'), turn('S1', 6, 9, 'and me')],
      [card('S0', 'Speaker A', String(gone._id)), card('S1', 'Speaker B', String(kept._id))],
    );
    await auth(request(app).delete(`/api/v1/speakers/${gone._id}`)).expect(204);
    const m = await MeetingModel.findById(id).lean();
    expect(await lineNames(id)).toEqual(['Unknown speaker', 'Parag']);
    expect(m?.participants).toEqual(['Parag']);
    expect(m?.unknownCount).toBe(1);
  });

  it('shows the label again once the card is given a (new) person', async () => {
    await asHeet();
    const gone = await voice('Speaker A (Meeting Post)', 'vp-a');
    const id = await seedMeeting(
      'Post',
      [turn('S0', 0, 5, 'hello there')],
      [card('S0', 'Speaker A', String(gone._id))],
    );
    await auth(request(app).delete(`/api/v1/speakers/${gone._id}`)).expect(204);
    const again = await voice('Speaker A (Meeting Post)', 'vp-a2');
    await MeetingDataModel.updateOne(
      { meetingId: id },
      { $set: { 'speakerCards.0.personId': String(again._id) } },
    );
    await applyNames(id);
    expect(await lineNames(id)).toEqual(['Speaker A']);
  });

  it('takes its open undo records, and the copy of its voiceprints, with it', async () => {
    await asHeet();
    const from = await voice('Speaker A (Meeting Post)', 'vp-a');
    const into = await person('Parag', { voiceprints: [vp('vp-parag')] });
    const done = await merge(from._id, into._id).expect(200);
    expect(await SpeakerUndoModel.countDocuments({})).toBe(1);
    await auth(request(app).delete(`/api/v1/speakers/${into._id}`)).expect(204);
    expect(await SpeakerUndoModel.countDocuments({})).toBe(0);
    await undo(done.body.undoId).expect(404);
  });
});

describe('people who have left can come back', () => {
  it('is matched again in new meetings after "return"', async () => {
    await asHeet();
    const p = await person('Parag', { voiceprints: [vp('vp-parag')] });
    await auth(request(app).post(`/api/v1/speakers/${p._id}/leave`)).expect(200);
    const heard = () => knownVoices(String(new Types.ObjectId()), String(workspace._id));
    expect(Object.values((await heard()).labelToPerson)).not.toContain(String(p._id));
    await auth(request(app).post(`/api/v1/speakers/${p._id}/return`)).expect(200);
    expect((await fresh(p._id))!.leftAt ?? null).toBeNull();
    expect(Object.values((await heard()).labelToPerson)).toContain(String(p._id));
    // coming back twice is fine
    await auth(request(app).post(`/api/v1/speakers/${p._id}/return`)).expect(200);
  });

  it('is only for the admin', async () => {
    const p = await person('Parag');
    await auth(request(app).post(`/api/v1/speakers/${p._id}/return`)).expect(403);
  });
});

describe('the controls can be switched off, and a name can be fixed to another case', () => {
  it('is off until it is switched on: a deploy changes nothing the client can see', async () => {
    await asHeet();
    delete process.env.SPEAKER_ASSIGN;
    resetEnvCache();
    const page = await auth(request(app).get('/api/v1/speakers')).expect(200);
    expect(page.body.canAssignSpeakers).toBe(false);
    expect(page.body.undos).toEqual([]);
    const p = await person('Parag');
    await auth(request(app).post(`/api/v1/speakers/${p._id}/leave`)).expect(403);
  });

  it('SPEAKER_ASSIGN=false hides and refuses assign, leave, return and undo', async () => {
    await asHeet();
    const from = await voice('Speaker A (Meeting Post)', 'vp-a');
    const into = await person('Parag');
    process.env.SPEAKER_ASSIGN = 'false';
    resetEnvCache();
    const page = await auth(request(app).get('/api/v1/speakers')).expect(200);
    expect(page.body.canAssignSpeakers).toBe(false);
    await merge(from._id, into._id).expect(403);
    await auth(request(app).post(`/api/v1/speakers/${into._id}/leave`)).expect(403);
    await auth(request(app).post(`/api/v1/speakers/${into._id}/return`)).expect(403);
    await undo(String(new Types.ObjectId())).expect(403);
    expect(await SpeakerModel.exists({ _id: from._id })).toBeTruthy();
  });

  it('allows "parag" to be corrected to "Parag", but not the same name again', async () => {
    await asHeet();
    const p = await person('parag');
    await assign(p._id, { name: 'parag', confirm: true }).expect(400);
    await assign(p._id, { name: 'Parag', confirm: true }).expect(200);
    expect((await fresh(p._id))!.name).toBe('Parag');
  });
});
