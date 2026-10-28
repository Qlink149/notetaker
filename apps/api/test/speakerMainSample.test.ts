import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import {
  MeetingModel,
  SpeakerModel,
  WorkspaceModel,
  type SpeakerDoc,
  type VoiceprintDoc,
  type WorkspaceDoc,
} from '../src/models/index.js';
import { knownVoices, pushVoiceprint } from '../src/services/identity/enroll.js';
import { mergePeople } from '../src/services/identity/edits.js';
import { mainSample } from '../src/services/identity/samples.js';
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

const meeting = (title: string) =>
  MeetingModel.create({
    workspaceId: workspace._id,
    title,
    status: 'completed',
    stage: 'done',
    audio: {
      originalUrl: 'x',
      originalPublicId: 'x',
      playbackUrl: `https://audio.test/${title}.mp3`,
    },
  });

const clip = (n: number, meetingId: Types.ObjectId | null, seconds: number, extra = {}) => ({
  id: `vp-${n}`,
  voiceprint: `voiceprint-${n}`,
  model: 'precision-2',
  source: 'meeting' as const,
  meetingId,
  clip: { start: n * 100, end: n * 100 + seconds },
  ...extra,
});
const recorded = (n: number) => ({
  id: `rec-${n}`,
  voiceprint: `recorded-${n}`,
  model: 'precision-2',
  source: 'enrolment' as const,
  audioUrl: 'https://audio.test/rec.wav',
});

describe('which sample is the one a person is recognised by (28 Oct)', () => {
  const oid = (c: string) => new Types.ObjectId(c.repeat(24));

  it('is the sample the person recorded of themselves, whatever came first', () => {
    const vs = [clip(0, oid('a'), 25), recorded(1), recorded(2)] as unknown as VoiceprintDoc[];
    // the latest recording; the earlier meeting clip is only a spare
    expect(mainSample(vs, null, new Set([String(oid('a'))]))?.id).toBe('rec-2');
  });

  it('otherwise the first clip that can still be heard and is long enough', () => {
    const gone = oid('b');
    const there = oid('c');
    const vs = [
      clip(0, there, 8), // too short
      clip(1, gone, 25), // its recording was deleted
      clip(2, there, 25), // this one
      clip(3, there, 30),
    ] as unknown as VoiceprintDoc[];
    expect(mainSample(vs, null, new Set([String(there)]))?.id).toBe('vp-2');
  });

  it('falls back to the first clip that can be heard, then to the first one, then to nothing', () => {
    const there = oid('c');
    const short = [clip(0, there, 8), clip(1, there, 9)] as unknown as VoiceprintDoc[];
    expect(mainSample(short, null, new Set([String(there)]))?.id).toBe('vp-0');
    const gone = [clip(0, oid('b'), 25), clip(1, oid('b'), 25)] as unknown as VoiceprintDoc[];
    expect(mainSample(gone, null, new Set())?.id).toBe('vp-0');
    expect(mainSample([], null, new Set())).toBeUndefined();
  });

  it('is the chosen one while it is usable, and never a removed or unusable one', () => {
    const there = oid('c');
    const vs = [
      clip(0, there, 25),
      clip(1, there, 25),
      clip(2, there, 25, { removedAt: new Date() }),
      clip(3, there, 25, { model: 'precision-3' }),
    ] as unknown as VoiceprintDoc[];
    const seen = new Set([String(there)]);
    const usable = (v: { model?: string }) => v.model === 'precision-2';
    expect(mainSample(vs, 'vp-1', seen, usable)?.id).toBe('vp-1');
    expect(mainSample(vs, 'vp-2', seen, usable)?.id).toBe('vp-0');
    expect(mainSample(vs, 'vp-3', seen, usable)?.id).toBe('vp-0');
    expect(mainSample(vs, 'nope', seen, usable)?.id).toBe('vp-0');
  });
});

async function seedThree() {
  const mtg = await meeting('AOM');
  const person = await SpeakerModel.create({
    workspaceId: workspace._id,
    name: 'Parag',
    voiceprints: [clip(0, mtg._id, 6), clip(1, mtg._id, 22), clip(2, mtg._id, 25)],
  });
  const base = `/api/v1/speakers/${person._id}/samples`;
  const list = async () =>
    (await auth(request(app).get(base)).expect(200)).body.samples as {
      key: string;
      main: boolean;
      removed: boolean;
    }[];
  const use = (key: string) => auth(request(app).post(`${base}/${key}/main`).send({}));
  const remove = (key: string) => auth(request(app).post(`${base}/${key}/remove`).send({}));
  const fresh = () => SpeakerModel.findById(person._id).lean<SpeakerDoc>();
  return { mtg, person, list, use, remove, fresh };
}

describe('one voice per person: the Speakers page and identify', () => {
  it('marks exactly one sample as the voice, the first long one by default', async () => {
    const { list } = await seedThree();
    expect((await list()).map((s) => s.main)).toEqual([false, true, false]);
  });

  it('sends only that sample to identify, labelled by its place in the list', async () => {
    const { person, list, use } = await seedThree();
    const id = String(new Types.ObjectId());
    let sent = await knownVoices(id, String(workspace._id));
    expect(sent.refs).toEqual([{ label: `${person._id}-1`, voiceprint: 'voiceprint-1' }]);
    await use((await list())[2]!.key).expect(200);
    sent = await knownVoices(id, String(workspace._id));
    expect(sent.refs).toEqual([{ label: `${person._id}-2`, voiceprint: 'voiceprint-2' }]);
    expect(sent.labelToPerson).toEqual({ [`${person._id}-2`]: String(person._id) });
  });

  it('keeps the position of a sample when another one is removed', async () => {
    const { person, list, remove } = await seedThree();
    const id = String(new Types.ObjectId());
    await remove((await list())[1]!.key).expect(200);
    const sent = await knownVoices(id, String(workspace._id));
    // the default moves to the next long clip, still called by its own place in the list
    expect(sent.refs).toEqual([{ label: `${person._id}-2`, voiceprint: 'voiceprint-2' }]);
  });

  it('remembers a swap, and a clip learned later does not take the place', async () => {
    const { person, mtg, list, use, fresh } = await seedThree();
    const res = await use((await list())[0]!.key).expect(200);
    expect(res.body.samples.map((s: { main: boolean }) => s.main)).toEqual([true, false, false]);
    expect((await fresh())!.mainSampleId).toBe('vp-0');
    await pushVoiceprint(String(person._id), String(mtg._id), clip(9, mtg._id, 30) as unknown as VoiceprintDoc);
    expect((await list()).map((s) => s.main)).toEqual([true, false, false, false]);
  });

  it('cannot make a removed or unknown sample the voice', async () => {
    const { list, use, remove } = await seedThree();
    const [first] = await list();
    await remove(first!.key).expect(200);
    await use(first!.key).expect(409);
    await use('0000000000000000').expect(404);
  });

  it('is for people of this workspace, and needs a login', async () => {
    const { person, list } = await seedThree();
    const key = (await list())[0]!.key;
    await request(app)
      .post(`/api/v1/speakers/${person._id}/samples/${key}/main`)
      .send({})
      .expect(401);
    const other = await WorkspaceModel.create({ name: 'Other', slug: 'other', accessCodeHash: 'x' });
    const stranger = await SpeakerModel.create({
      workspaceId: other._id,
      name: 'S',
      voiceprints: [clip(5, null, 25)],
    });
    await auth(
      request(app).post(`/api/v1/speakers/${stranger._id}/samples/${key}/main`).send({}),
    ).expect(404);
  });

  it('falls back to the default when the chosen clip is removed from under it', async () => {
    const { person, list, use } = await seedThree();
    await use((await list())[2]!.key).expect(200);
    await SpeakerModel.updateOne(
      { _id: person._id },
      { $set: { 'voiceprints.2.removedAt': new Date() } },
    );
    expect((await list()).map((s) => s.main)).toEqual([false, true, false]);
  });

  it('a merge keeps the voice the surviving person is recognised by', async () => {
    const { person, mtg, list, use } = await seedThree();
    await use((await list())[2]!.key).expect(200);
    const other = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Parag 2',
      voiceprints: [recorded(7)],
    });
    await mergePeople(String(person._id), String(other._id));
    expect((await list()).map((s) => s.main)).toEqual([false, false, true, false]);
    // and when the survivor had never chosen: its default is pinned before a recording joins it
    const solo = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Solo',
      voiceprints: [clip(0, mtg._id, 25)],
    });
    const rec = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Solo rec',
      voiceprints: [recorded(8)],
    });
    await mergePeople(String(solo._id), String(rec._id));
    expect((await SpeakerModel.findById(solo._id).lean<SpeakerDoc>())!.mainSampleId).toBe('vp-0');
  });
});
