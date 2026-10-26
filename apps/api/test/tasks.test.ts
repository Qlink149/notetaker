import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { draftTask, isoDay } from '@meetingid/pipeline';
import { createApp } from '../src/app.js';
import { logger } from '../src/lib/logger.js';
import {
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  TaskModel,
  type JobDoc,
  type WorkspaceDoc,
} from '../src/models/index.js';
import { summariseStage } from '../src/pipeline/stages/40-summarise.js';
import {
  ACCESS_CODE,
  clearDb,
  fakeStorage,
  seedWorkspace,
  startDb,
  stopDb,
  testDeps,
} from './helpers.js';

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
const api = {
  get: (p: string) => auth(request(app).get(`/api/v1${p}`)),
  post: (p: string, b?: object) => auth(request(app).post(`/api/v1${p}`)).send(b ?? {}),
  patch: (p: string, b: object) => auth(request(app).patch(`/api/v1${p}`)).send(b),
  put: (p: string, b: object) => auth(request(app).put(`/api/v1${p}`)).send(b),
  del: (p: string) => auth(request(app).delete(`/api/v1${p}`)),
};

/** Heet and Paresh in the directory; a meeting on Tue 20 Oct 2026 whose Speaker A is Heet. */
async function seed() {
  const heet = await SpeakerModel.create({
    workspaceId: workspace._id,
    name: 'Heet Dholakia',
    anonymous: false,
  });
  const paresh = await SpeakerModel.create({
    workspaceId: workspace._id,
    name: 'Paresh Shah',
    anonymous: false,
  });
  const m = await MeetingModel.create({
    workspaceId: workspace._id,
    title: 'Diwali planning',
    date: new Date('2026-10-20T05:00:00Z'),
    status: 'completed',
    stage: 'done',
    summaryStatus: 'completed',
    summary: '## Decisions\n- Launch the Diwali offer in all stores',
    summaryAt: new Date(),
    actionItems: [
      { speakerName: 'Heet Dholakia', text: 'Approve the offer pricing by tomorrow' },
      { speakerName: 'Paresh', text: 'Share the top stores report by Friday' },
      { speakerName: 'Speaker C', text: 'Book the hall' },
    ],
    audio: { originalUrl: 'x', originalPublicId: 'x' },
  });
  await MeetingDataModel.create({
    meetingId: m._id,
    speakerSource: 'pyannote',
    speakerCards: [
      {
        diar: 'S0',
        label: 'Speaker A',
        personId: String(heet._id),
        speakerSec: 100,
        match: null,
        candidate: null,
        status: 'manual',
        clips: [],
      },
    ],
    lines: [
      {
        start: 125,
        end: 130,
        speakerName: 'Heet Dholakia',
        textRoman: 'Bhiwandi ka dispatch kal tak clear karo',
        textNative: '',
      },
    ],
  });
  return { heet, paresh, m };
}

describe('suggested tasks from a meeting’s action items', () => {
  it('offers each action item with its owner and a deadline counted from the meeting day', async () => {
    const { heet, paresh, m } = await seed();
    const res = await api.get(`/meetings/${String(m._id)}/task-suggestions`).expect(200);
    expect(res.body.suggestions).toEqual([
      expect.objectContaining({
        index: 0,
        title: 'Approve the offer pricing',
        due: '2026-10-21',
        priority: 'high',
        ownerId: String(heet._id),
        meetingTitle: 'Diwali planning',
      }),
      // a first name that only one person has
      expect.objectContaining({ index: 1, due: '2026-10-23', ownerId: String(paresh._id) }),
      // a voice nobody named: the person picks the owner
      expect.objectContaining({ index: 2, due: null, ownerId: null, speakerName: 'Speaker C' }),
    ]);
    expect((await api.get('/task-suggestions').expect(200)).body.suggestions).toHaveLength(3);
  });

  it('approving makes a task once; skipping hides it; a new summary offers its items again', async () => {
    const { heet, m } = await seed();
    const id = String(m._id);
    const created = await api
      .post('/tasks', {
        title: 'Approve the offer pricing',
        ownerId: String(heet._id),
        priority: 'high',
        due: '2026-10-21',
        fromSuggestion: { meetingId: id, index: 0 },
      })
      .expect(201);
    expect(created.body.task).toMatchObject({
      ownerName: 'Heet Dholakia',
      meetingId: id,
      meetingTitle: 'Diwali planning',
      source: { meetingId: id, index: 0, text: 'Approve the offer pricing by tomorrow' },
      status: 'open',
    });
    await api
      .post('/tasks', {
        title: 'again',
        ownerId: String(heet._id),
        fromSuggestion: { meetingId: id, index: 0 },
      })
      .expect(409);
    await api.post(`/meetings/${id}/task-suggestions/2/skip`).expect(204);
    let left = (await api.get(`/meetings/${id}/task-suggestions`)).body.suggestions;
    expect(left.map((s: { index: number }) => s.index)).toEqual([1]);

    // the summary is written again (new content, e.g. after a continuation): its action items are suggested
    // afresh, except one already made a task from this meeting
    await MeetingModel.updateOne(
      { _id: m._id },
      { $set: { summaryAt: new Date(Date.now() + 1000) } },
    );
    left = (await api.get(`/meetings/${id}/task-suggestions`)).body.suggestions;
    expect(left.map((s: { index: number }) => s.index)).toEqual([1, 2]);
  });
});

describe('tasks', () => {
  it('ticks off and reopens, keeps a buddy distinct from the owner, and refuses unknown people', async () => {
    const { heet, paresh } = await seed();
    const t = (
      await api
        .post('/tasks', {
          title: 'Call the foam supplier',
          ownerId: String(heet._id),
          buddyId: String(paresh._id),
          due: '2026-10-22',
        })
        .expect(201)
    ).body.task;
    expect(t).toMatchObject({ buddyName: 'Paresh Shah', priority: 'med', meetingId: null });

    const done = (await api.patch(`/tasks/${t.id}`, { status: 'done' }).expect(200)).body.task;
    expect(done.status).toBe('done');
    expect(done.doneAt).toBeTruthy();
    const reopened = (await api.patch(`/tasks/${t.id}`, { status: 'open' }).expect(200)).body.task;
    expect(reopened.doneAt).toBeNull();

    const same = (await api.patch(`/tasks/${t.id}`, { ownerId: String(paresh._id) }).expect(200))
      .body.task;
    expect(same).toMatchObject({ ownerName: 'Paresh Shah', buddyId: null });

    await api.patch(`/tasks/${t.id}`, { ownerId: String(new Types.ObjectId()) }).expect(400);
    await api.post('/tasks', { title: 'x', ownerId: String(new Types.ObjectId()) }).expect(400);
    await api.post('/tasks', { title: '', ownerId: String(heet._id) }).expect(400);

    expect((await api.get('/tasks').expect(200)).body.tasks).toHaveLength(1);
    await api.del(`/tasks/${t.id}`).expect(204);
    expect((await api.get('/tasks')).body.tasks).toHaveLength(0);
  });

  it('records who gave a task once "me" is set', async () => {
    const { heet, paresh } = await seed();
    await api.put('/workspace/me', { personId: String(heet._id) }).expect(200);
    expect((await api.get('/auth/me').expect(200)).body.workspace.mePersonId).toBe(
      String(heet._id),
    );
    const t = (
      await api.post('/tasks', { title: 'Report', ownerId: String(paresh._id) }).expect(201)
    ).body.task;
    expect(t).toMatchObject({ createdById: String(heet._id), createdByName: 'Heet Dholakia' });
    await api.put('/workspace/me', { personId: String(new Types.ObjectId()) }).expect(400);
  });

  it('does not show or change another workspace’s tasks', async () => {
    const { heet } = await seed();
    const other = await TaskModel.create({
      workspaceId: new Types.ObjectId(),
      title: 'secret',
      ownerId: heet._id,
    });
    expect((await api.get('/tasks')).body.tasks).toHaveLength(0);
    await api.patch(`/tasks/${String(other._id)}`, { status: 'done' }).expect(404);
    await api.del(`/tasks/${String(other._id)}`).expect(404);
  });

  it('deleting a meeting removes the tasks made from it', async () => {
    const { heet, m } = await seed();
    await api
      .post('/tasks', { title: 'From it', ownerId: String(heet._id), meetingId: String(m._id) })
      .expect(201);
    await api.post('/tasks', { title: 'Separate', ownerId: String(heet._id) }).expect(201);
    await api.del(`/meetings/${String(m._id)}`).expect((r) => expect(r.status).toBeLessThan(300));
    const left = (await api.get('/tasks')).body.tasks.map((t: { title: string }) => t.title);
    expect(left).toEqual(['Separate']);
  });
});

describe('summary refresh follows corrected speakers', () => {
  it('moves untouched tasks, drops a person who has left, and keeps edits, completed work and other meetings', async () => {
    const day = new Date('2026-10-24T05:00:00.000Z');
    const meetingDay = isoDay(day);
    const harshit = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Harshit Mehta',
      anonymous: false,
    });
    const priya = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: 'Priya Shah',
      anonymous: false,
    });
    const send = 'Send the samples by tomorrow';
    const book = 'Book the hall';
    const sendDraft = draftTask(send, meetingDay);
    const bookDraft = draftTask(book, meetingDay);
    const m = await MeetingModel.create({
      workspaceId: workspace._id,
      title: 'NDPF 24 Oct',
      date: day,
      status: 'processing',
      stage: 'summarise',
      summaryStatus: 'pending',
      summary: 'Harshit Mehta will send the samples and book the hall.',
      actionItems: [
        { speakerName: 'Harshit Mehta', text: send },
        { speakerName: 'Harshit Mehta', text: book },
      ],
      coverage: { speechSec: 100, coveredSec: 90, ratio: 0.9 },
      audio: { originalUrl: 'x', originalPublicId: 'x' },
    });
    await MeetingDataModel.create({
      meetingId: m._id,
      lines: [
        {
          speakerName: 'Priya Shah',
          start: 0,
          end: 5,
          textRoman: 'send the samples',
          textNative: '',
        },
      ],
      speakerCards: [
        {
          diar: 'S0',
          label: 'Speaker A',
          personId: String(priya._id),
          speakerSec: 30,
          match: null,
          candidate: null,
          status: 'manual',
          clips: [],
        },
      ],
    });
    const other = await MeetingModel.create({
      workspaceId: workspace._id,
      title: 'Other meeting',
      date: day,
      status: 'completed',
      stage: 'done',
      audio: { originalUrl: 'x', originalPublicId: 'x' },
    });
    const open = await TaskModel.create({
      workspaceId: workspace._id,
      meetingId: m._id,
      ownerId: harshit._id,
      title: sendDraft.title,
      priority: sendDraft.priority,
      due: sendDraft.due,
      status: 'open',
      source: { meetingId: m._id, index: 0, text: send },
    });
    const dropped = await TaskModel.create({
      workspaceId: workspace._id,
      meetingId: m._id,
      ownerId: harshit._id,
      title: bookDraft.title,
      priority: bookDraft.priority,
      due: bookDraft.due,
      status: 'open',
      source: { meetingId: m._id, index: 1, text: book },
    });
    const done = await TaskModel.create({
      workspaceId: workspace._id,
      meetingId: m._id,
      ownerId: harshit._id,
      title: sendDraft.title,
      priority: sendDraft.priority,
      due: sendDraft.due,
      status: 'done',
      doneAt: day,
      source: { meetingId: m._id, index: 0, text: send },
    });
    const edited = await TaskModel.create({
      workspaceId: workspace._id,
      meetingId: m._id,
      ownerId: harshit._id,
      title: 'Send the dyed samples',
      priority: sendDraft.priority,
      due: sendDraft.due,
      status: 'open',
      source: { meetingId: m._id, index: 0, text: send },
    });
    const elsewhere = await TaskModel.create({
      workspaceId: workspace._id,
      meetingId: other._id,
      ownerId: harshit._id,
      title: sendDraft.title,
      priority: sendDraft.priority,
      due: sendDraft.due,
      status: 'open',
      source: { meetingId: other._id, index: 0, text: send },
    });

    const now = new Date();
    const job = {
      _id: new Types.ObjectId(),
      meetingId: m._id,
      stage: 'summarise',
      step: null,
      status: 'running',
      attempts: 1,
      maxAttempts: 5,
      runAfter: now,
      lockedBy: 'test',
      lockedAt: now,
      lastError: null,
      payload: { force: true },
      createdAt: now,
      updatedAt: now,
    } as JobDoc;
    await summariseStage.run({
      job,
      log: logger,
      deps: testDeps({
        storage: await fakeStorage(),
        engine: () => {
          throw new Error('unused');
        },
        summariser: {
          async summarise() {
            return {
              result: {
                summaryMarkdown: '## Overview\nPriya Shah will send the samples.',
                actionItems: [{ speakerName: 'Priya Shah', text: send }],
              },
              usage: { inputTokens: 10, outputTokens: 10 },
            };
          },
        },
      }),
      tmpDir: '/tmp',
    });

    const after = (await MeetingModel.findById(m._id).lean())!;
    expect(after.summary).toBe('## Overview\nPriya Shah will send the samples.');
    expect(after.summary).not.toContain('Harshit');
    expect(after.summaryOutdated).toBe(false);
    expect(String((await TaskModel.findById(open._id).lean())?.ownerId)).toBe(String(priya._id));
    expect(await TaskModel.findById(dropped._id).lean()).toBeNull();
    expect(String((await TaskModel.findById(done._id).lean())?.ownerId)).toBe(String(harshit._id));
    expect((await TaskModel.findById(edited._id).lean())?.ownerId?.toString()).toBe(
      String(harshit._id),
    );
    const kept = (await TaskModel.findById(elsewhere._id).lean())!;
    expect(String(kept.ownerId)).toBe(String(harshit._id));
    expect(String(kept.meetingId)).toBe(String(other._id));
  });
});

describe('search', () => {
  it('finds meetings by title, summary and what was said, with the time it was said', async () => {
    const { m } = await seed();
    const id = String(m._id);
    expect((await api.get('/search?q=diwali').expect(200)).body.results).toEqual([
      expect.objectContaining({ meetingId: id, title: 'Diwali planning', at: null }),
    ]);
    const said = (await api.get('/search?q=bhiwandi%20dispatch').expect(200)).body.results;
    expect(said).toEqual([expect.objectContaining({ meetingId: id, at: 125 })]);
    expect(said[0].snippet).toMatch(/Bhiwandi ka dispatch/);
    expect((await api.get('/search?q=nothing-like-this').expect(200)).body.results).toEqual([]);
    expect((await api.get('/search?q=(').expect(200)).body.results).toEqual([]);
  });
});
