import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  JobModel,
  MeetingDataModel,
  MeetingModel,
  type WorkspaceDoc,
} from '../src/models/index.js';
import { claimNext, enqueue } from '../src/pipeline/queue.js';
import { Runner } from '../src/pipeline/runner.js';
import { stages } from '../src/pipeline/stages/index.js';
import {
  clearDb,
  fakeEngine,
  fakeStorage,
  fakeSummariser,
  makeFixture,
  okResult,
  seedWorkspace,
  startDb,
  stopDb,
  testDeps,
  turnsCovering,
} from './helpers.js';

let fixture: string;
let workspace: WorkspaceDoc;

beforeAll(async () => {
  await startDb();
  fixture = await makeFixture(await mkdtemp(join(tmpdir(), 'fixture-')));
});
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  workspace = await seedWorkspace();
});

async function createMeeting(engine: 'gemini' | 'deepgram' = 'gemini') {
  const id = new Types.ObjectId();
  await MeetingModel.create({
    _id: id,
    workspaceId: workspace._id,
    title: 'fixture',
    status: 'processing',
    stage: 'ingest',
    engine,
    languages: ['hi', 'gu', 'en'],
    audio: {
      originalUrl: fixture,
      originalPublicId: `workspaces/notetaker/meetings/${String(id)}/original`,
    },
  });
  await enqueue({ meetingId: id, stage: 'ingest' });
  return id;
}

describe('worker state machine', () => {
  it('runs a 2-minute recording from ingest to done', async () => {
    const engine = fakeEngine((input) => okResult(turnsCovering(0, input.endSec - input.startSec)));
    const summariser = fakeSummariser();
    const runner = new Runner(
      testDeps({ storage: await fakeStorage(), engine: () => engine, summariser }),
      stages,
    );
    const id = await createMeeting();

    await runner.drain();

    const m = await MeetingModel.findById(id).lean();
    expect(m?.status).toBe('completed');
    expect(m?.stage).toBe('done');
    expect(m?.durationSec).toBeCloseTo(120, 0);
    expect(m?.progress).toEqual({ chunksTotal: 1, chunksDone: 1 });
    expect(m?.coverage?.ratio).toBeGreaterThan(0.9);
    expect(m?.summaryStatus).toBe('completed');
    expect(m?.actionItems).toEqual([{ speakerName: 'Speaker 1', text: 'Send the plan.' }]);
    expect(m?.cost.geminiInputTokens).toBe(1000);
    expect(m?.cost.claudeInputTokens).toBe(500);
    expect(m?.audio.analysisUrl).toBeTruthy();
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]!.audio.kind).toBe('gemini-file');
    expect(engine.calls[0]!.glossary?.entries[0]?.term).toBe('Kisna');
    expect(summariser.calls).toBe(1);

    const data = await MeetingDataModel.findOne({ meetingId: id }).lean();
    expect(data?.lines.length).toBeGreaterThan(0);
    expect(data?.lines.every((l) => l.end - l.start <= 45)).toBe(true);
    expect(data?.lines[0]?.textNative).toContain('वाक्य');
    expect(data?.speakerMap).toEqual({ S1: 'Speaker 1', S2: 'Speaker 2' });
    expect(data?.speechSegments.length).toBe(2);
    expect(await JobModel.countDocuments({ status: { $ne: 'done' } })).toBe(0);
  });

  it('withholds the summary and ends partial when coverage is low', async () => {
    const engine = fakeEngine(() => okResult(turnsCovering(0, 12)));
    const summariser = fakeSummariser();
    const runner = new Runner(
      testDeps({ storage: await fakeStorage(), engine: () => engine, summariser }),
      stages,
    );
    const id = await createMeeting();

    await runner.drain();

    const m = await MeetingModel.findById(id).lean();
    expect(m?.coverage?.ratio).toBeLessThan(0.6);
    expect(m?.status).toBe('partial');
    expect(m?.summaryStatus).toBe('skipped_low_coverage');
    expect(m?.summary).toBeNull();
    expect(summariser.calls).toBe(0);
  });

  it('retries truncated output with backoff and does not restart from zero', async () => {
    let clock = Date.now() + 5_000; // ahead of the real-time runAfter stamped by enqueue
    const engine = fakeEngine((input, call) =>
      call === 1
        ? { ...okResult([]), finish: 'truncated' }
        : okResult(turnsCovering(0, input.endSec - input.startSec)),
    );
    const runner = new Runner(
      testDeps({ storage: await fakeStorage(), engine: () => engine, now: () => new Date(clock) }),
      stages,
    );
    const id = await createMeeting();
    await runner.drain();
    expect((await MeetingModel.findById(id).lean())?.stage).toBe('transcribe');

    clock += 60 * 60_000; // past the backoff
    await runner.drain();
    const m = await MeetingModel.findById(id).lean();
    expect(m?.status).toBe('completed');
    expect(engine.calls).toHaveLength(2);
    expect(m?.cost.geminiInputTokens).toBe(2000); // the truncated call was paid for, and recorded
  });

  it('resumes after a worker dies mid-transcribe without paying twice', async () => {
    let clock = Date.now() + 5_000; // ahead of the real-time runAfter stamped by enqueue
    const engine = fakeEngine((input) => okResult(turnsCovering(0, input.endSec - input.startSec)));
    const deps = testDeps({
      storage: await fakeStorage(),
      engine: () => engine,
      now: () => new Date(clock),
    });
    const id = await createMeeting();
    const runner = new Runner(deps, stages, { workerId: 'w2' });
    await runner.runOnce(); // ingest

    // A worker claims the transcribe job, then dies before finishing.
    const dead = await claimNext('dead-worker', new Date(clock));
    expect(dead?.stage).toBe('transcribe');
    expect(await runner.drain()).toBe(0); // locked: nobody else may run it

    clock += 9 * 60_000; // past the 8-minute transcribe lease
    await runner.drain();
    const m = await MeetingModel.findById(id).lean();
    expect(m?.status).toBe('completed');
    expect(engine.calls).toHaveLength(1);

    // A stray duplicate job for an already-done chunk costs nothing.
    await JobModel.create({ meetingId: id, stage: 'transcribe', step: 0 });
    await runner.drain();
    expect(engine.calls).toHaveLength(1);
  });

  it('gives up on a chunk after max attempts and still assembles (partial)', async () => {
    let clock = Date.now() + 5_000; // ahead of the real-time runAfter stamped by enqueue
    const engine = fakeEngine(() => Object.assign(new Error('rate limited'), { status: 429 }));
    const runner = new Runner(
      testDeps({ storage: await fakeStorage(), engine: () => engine, now: () => new Date(clock) }),
      stages,
    );
    const id = await createMeeting();
    for (let i = 0; i < 8; i++) {
      await runner.drain();
      clock += 2 * 3600_000;
    }
    const m = await MeetingModel.findById(id).lean();
    expect(engine.calls).toHaveLength(5);
    expect(m?.stage).toBe('done');
    expect(m?.status).toBe('partial');
    expect(m?.summaryStatus).toBe('skipped_low_coverage');
  });

  it('fails the meeting with a human message on a fatal ingest error', async () => {
    const engine = fakeEngine(() => okResult([]));
    const runner = new Runner(
      testDeps({ storage: await fakeStorage(), engine: () => engine }),
      stages,
    );
    const id = new Types.ObjectId();
    await MeetingModel.create({
      _id: id,
      workspaceId: workspace._id,
      title: 'broken',
      status: 'processing',
      engine: 'gemini',
      audio: { originalUrl: join(tmpdir(), 'does-not-exist.mp3'), originalPublicId: 'x' },
    });
    await enqueue({ meetingId: id, stage: 'ingest', maxAttempts: 1 });
    await runner.drain();
    const m = await MeetingModel.findById(id).lean();
    expect(m?.status).toBe('failed');
    expect(m?.error?.stage).toBe('ingest');
    expect(m?.error?.retryable).toBe(true);
  });
});
