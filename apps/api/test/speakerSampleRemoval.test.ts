import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import {
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  WorkspaceModel,
  type SpeakerDoc,
  type WorkspaceDoc,
} from '../src/models/index.js';
import { addVoiceprints, knownVoices, pushVoiceprint } from '../src/services/identity/enroll.js';
import { mergePeople } from '../src/services/identity/edits.js';
import { sampleKey } from '../src/services/identity/samples.js';
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

const entry = (n: number, meetingId: Types.ObjectId, start: number) => ({
  id: new Types.ObjectId().toString(),
  voiceprint: `secret-voiceprint-${n}`,
  model: 'precision-2',
  source: 'meeting' as const,
  meetingId,
  clip: { start, end: start + 20 },
});

/** Harshit with three samples: two from the AOM meeting and one from Google DV. */
async function seed() {
  const aom = await meeting('AOM');
  const dv = await meeting('Google DV');
  const person = await SpeakerModel.create({
    workspaceId: workspace._id,
    name: 'Harshit Google DV360',
    voiceprints: [entry(0, aom._id, 10), entry(1, aom._id, 100), entry(2, dv._id, 5)],
  });
  const list = async () =>
    (await auth(request(app).get(`/api/v1/speakers/${person._id}/samples`)).expect(200)).body
      .samples as { key: string; removed: boolean; meetingId: string; meetingConfirmed: boolean }[];
  const remove = (key: string, bodyIn: object = {}) =>
    auth(request(app).post(`/api/v1/speakers/${person._id}/samples/${key}/remove`).send(bodyIn));
  const restore = (key: string) =>
    auth(request(app).post(`/api/v1/speakers/${person._id}/samples/${key}/restore`).send({}));
  const fresh = () => SpeakerModel.findById(person._id).lean<SpeakerDoc>();
  return { aom, dv, person, list, remove, restore, fresh };
}

describe('removing and restoring one voice sample (28 Oct)', () => {
  it('names each sample with a key that is not its id and never shows the voiceprint', async () => {
    const { list, person } = await seed();
    const samples = await list();
    expect(new Set(samples.map((s) => s.key)).size).toBe(3);
    const stored = (await SpeakerModel.findById(person._id).lean<SpeakerDoc>())!;
    for (const v of stored.voiceprints) expect(samples.map((s) => s.key)).not.toContain(v.id);
    expect(JSON.stringify(samples)).not.toContain('secret-voiceprint');
    expect(samples.every((s) => s.removed === false)).toBe(true);
  });

  it('removes only that sample, keeps it on the profile, and stops counting it', async () => {
    const { list, remove, fresh, person } = await seed();
    const [, second] = await list();
    const res = await remove(second!.key).expect(200);
    expect(res.body.samples.map((s: { removed: boolean }) => s.removed)).toEqual([
      false,
      true,
      false,
    ]);
    const stored = (await fresh())!;
    expect(stored.voiceprints).toHaveLength(3);
    expect(stored.voiceprints[1]!.removedAt).toBeTruthy();
    const people = (await auth(request(app).get('/api/v1/speakers')).expect(200)).body.speakers;
    expect(people.find((p: { id: string }) => p.id === String(person._id))).toMatchObject({
      voiceprintCount: 2,
      hasVoiceprint: true,
    });
  });

  it('is the same when pressed twice, and a restore puts it back', async () => {
    const { list, remove, restore, fresh } = await seed();
    const [first] = await list();
    await remove(first!.key).expect(200);
    const when = (await fresh())!.voiceprints[0]!.removedAt;
    await remove(first!.key).expect(200);
    expect((await fresh())!.voiceprints[0]!.removedAt).toEqual(when);
    await restore(first!.key).expect(200);
    expect((await fresh())!.voiceprints[0]!.removedAt ?? null).toBeNull();
    await restore(first!.key).expect(200);
  });

  it('can also ignore the rest of that meeting, and restoring lets it be learned again', async () => {
    const { list, remove, restore, fresh, aom, dv } = await seed();
    const [first] = await list();
    await remove(first!.key, { ignoreMeeting: true }).expect(200);
    let stored = (await fresh())!;
    expect(stored.voiceprints.map((v) => !!v.removedAt)).toEqual([true, true, false]);
    expect(stored.ignoreMeetings.map(String)).toEqual([String(aom._id)]);
    expect(stored.ignoreMeetings.map(String)).not.toContain(String(dv._id));
    await restore(first!.key).expect(200);
    stored = (await fresh())!;
    expect(stored.ignoreMeetings).toHaveLength(0);
    expect(stored.voiceprints.map((v) => !!v.removedAt)).toEqual([false, true, false]);
  });

  it('can remove a person’s last sample', async () => {
    const m = await meeting('Solo');
    const p = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Solo',
      voiceprints: [entry(9, m._id, 3)],
    });
    const key = sampleKey((await SpeakerModel.findById(p._id).lean<SpeakerDoc>())!.voiceprints[0]!);
    await auth(
      request(app).post(`/api/v1/speakers/${p._id}/samples/${key}/remove`).send({}),
    ).expect(200);
    const row = (await auth(request(app).get('/api/v1/speakers')).expect(200)).body.speakers.find(
      (x: { id: string }) => x.id === String(p._id),
    );
    expect(row).toMatchObject({ voiceprintCount: 0, hasVoiceprint: false });
  });

  it('tells when a person confirmed a voice of that meeting as this person', async () => {
    const { list, person, aom } = await seed();
    await MeetingDataModel.create({
      meetingId: aom._id,
      turns: [],
      speakerSource: 'pyannote',
      speakerCards: [
        {
          diar: 'S0',
          label: 'A',
          personId: String(person._id),
          speakerSec: 90,
          match: null,
          candidate: null,
          status: 'manual',
          confirmed: true,
          clips: [],
        },
      ],
    });
    const samples = await list();
    expect(samples.map((s) => s.meetingConfirmed)).toEqual([true, true, false]);
  });

  it('404 for an unknown sample or another workspace’s person, 401 without login', async () => {
    const { person, remove } = await seed();
    await remove('0000000000000000').expect(404);
    const other = await WorkspaceModel.create({
      name: 'Other',
      slug: 'other',
      accessCodeHash: 'x',
    });
    const stranger = await SpeakerModel.create({
      workspaceId: other._id,
      name: 'S',
      voiceprints: [entry(7, new Types.ObjectId(), 1)],
    });
    const key = sampleKey(
      (await SpeakerModel.findById(stranger._id).lean<SpeakerDoc>())!.voiceprints[0]!,
    );
    await auth(
      request(app).post(`/api/v1/speakers/${stranger._id}/samples/${key}/remove`).send({}),
    ).expect(404);
    await request(app)
      .post(`/api/v1/speakers/${person._id}/samples/${key}/remove`)
      .send({})
      .expect(401);
  });
});

describe('what a removal changes for identifying later meetings', () => {
  it('does not send a removed sample, and the others keep their labels', async () => {
    const { list, remove, person } = await seed();
    const meetingId = String(new Types.ObjectId());
    // one voice per person: the first sample, as all three are long enough and can be heard
    const before = await knownVoices(meetingId, String(workspace._id));
    expect(before.refs.map((r) => r.label)).toEqual([`${person._id}-0`]);
    await remove((await list())[0]!.key).expect(200);
    const after = await knownVoices(meetingId, String(workspace._id));
    // position 0 is gone; the next sample is still called by its own place, so earlier identify results still mean the same sample
    expect(after.refs.map((r) => r.label)).toEqual([`${person._id}-1`]);
    expect(after.refs.map((r) => r.voiceprint)).toEqual(['secret-voiceprint-1']);
  });

  it('is not learned again from the same clip, and not at all from an ignored meeting', async () => {
    const { person, aom, dv } = await seed();
    const clip = (start: number) => ({ speaker: 'S0', start, end: start + 20, quality: 80 });
    // sample 0 of the AOM meeting starts at 10: removed, so it is still "already there"
    await SpeakerModel.updateOne(
      { _id: person._id },
      { $set: { 'voiceprints.0.removedAt': new Date() } },
    );
    expect(await addVoiceprints(String(aom._id), String(person._id), 'S0', [clip(10)])).toBe(0);
    // an ignored meeting is skipped before any audio is touched
    await SpeakerModel.updateOne({ _id: person._id }, { $addToSet: { ignoreMeetings: dv._id } });
    expect(await addVoiceprints(String(dv._id), String(person._id), 'S0', [clip(300)])).toBe(0);
  });

  it('cannot be added back by a learning job that was already running', async () => {
    const { person, aom, dv } = await seed();
    await SpeakerModel.updateOne({ _id: person._id }, { $addToSet: { ignoreMeetings: aom._id } });
    const e = (id: string) => ({
      id,
      voiceprint: id,
      model: 'precision-2',
      source: 'meeting' as const,
      audioUrl: '',
      meetingId: aom._id,
      clip: { start: 500, end: 520 },
    });
    expect(await pushVoiceprint(String(person._id), String(aom._id), e('late'))).toBe(0);
    expect((await SpeakerModel.findById(person._id).lean<SpeakerDoc>())!.voiceprints).toHaveLength(
      3,
    );
    expect(
      await pushVoiceprint(String(person._id), String(dv._id), { ...e('fine'), meetingId: dv._id }),
    ).toBe(1);
    expect((await SpeakerModel.findById(person._id).lean<SpeakerDoc>())!.voiceprints).toHaveLength(
      4,
    );
  });

  it('keeps removals and ignored meetings when two people are merged', async () => {
    const { person, aom } = await seed();
    await SpeakerModel.updateOne(
      { _id: person._id },
      { $set: { 'voiceprints.1.removedAt': new Date() }, $addToSet: { ignoreMeetings: aom._id } },
    );
    const keep = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Harshit (AOM)',
      voiceprints: [],
    });
    await mergePeople(String(keep._id), String(person._id));
    const merged = (await SpeakerModel.findById(keep._id).lean<SpeakerDoc>())!;
    expect(merged.voiceprints.map((v) => !!v.removedAt)).toEqual([false, true, false]);
    expect(merged.ignoreMeetings.map(String)).toEqual([String(aom._id)]);
  });
});
