import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// pyannote and Deepgram are mocked at their module boundary; everything else is the real pipeline.
const pya = vi.hoisted(() => ({
  uploads: [] as string[],
  submits: 0,
  polls: [] as string[],
  getJob: null as null | ((id: string) => unknown),
  submit: null as null | (() => Promise<string>),
}));

vi.mock('../src/services/pyannote/client.js', async () => {
  const real = await vi.importActual<Record<string, unknown>>('../src/services/pyannote/client.js');
  return {
    ...real,
    uploadMedia: vi.fn(async (_path: string, key: string) => {
      pya.uploads.push(key);
      return `media://${key}`;
    }),
    submitDiarize: vi.fn(async () => {
      pya.submits++;
      return pya.submit ? pya.submit() : `job-${pya.submits}`;
    }),
    getJob: vi.fn(async (id: string) => {
      pya.polls.push(id);
      return pya.getJob!(id);
    }),
  };
});

/** Deepgram "hears" exactly what the fake Gemini engine wrote, with real word times. */
vi.mock('../src/services/engines/deepgram.js', async () => {
  const real = await vi.importActual<Record<string, unknown>>(
    '../src/services/engines/deepgram.js',
  );
  const { turnsCovering } = await import('./helpers.js');
  return {
    ...real,
    deepgramWordClock: vi.fn(async () => {
      const words = turnsCovering(0, 120).flatMap((t) => {
        const w = t.text_native.split(' ');
        const step = (t.end - t.start) / w.length;
        return w.map((text, i) => ({
          text,
          start: t.start + i * step,
          end: t.start + (i + 1) * step - 0.05,
        }));
      });
      return {
        words,
        durationSec: 120,
        language: 'hi',
        raw: {
          results: {
            channels: [
              {
                alternatives: [
                  { words: words.map((x) => ({ word: x.text, start: x.start, end: x.end })) },
                ],
              },
            ],
          },
        },
      };
    }),
  };
});

// Naming voices needs audio and a paid API; the stage's contract (never fail the meeting) is what is tested here.
vi.mock('../src/services/identity/enroll.js', async () => {
  const { ensureCards } = await import('../src/services/identity/identity.js');
  return {
    identifyMeeting: vi.fn(async (meetingId: string) => {
      const cards = await ensureCards(meetingId);
      return { voiceprintsSent: 0, linked: [], newPeople: [], warnings: [], cards };
    }),
  };
});

import {
  JobModel,
  MeetingDataModel,
  MeetingModel,
  type WorkspaceDoc,
} from '../src/models/index.js';
import { P2PyannoteResponseModel } from '../src/models/phase2.js';
import { enqueue } from '../src/pipeline/queue.js';
import { Runner } from '../src/pipeline/runner.js';
import { stages } from '../src/pipeline/stages/index.js';
import { PyannoteError } from '../src/services/pyannote/client.js';
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
  Object.assign(pya, { uploads: [], submits: 0, polls: [], getJob: null, submit: null });
});

async function createMeeting() {
  const id = new Types.ObjectId();
  await MeetingModel.create({
    _id: id,
    workspaceId: workspace._id,
    title: 'fixture',
    status: 'processing',
    stage: 'ingest',
    engine: 'gemini',
    languages: ['hi', 'gu', 'en'],
    audio: {
      originalUrl: fixture,
      originalPublicId: `workspaces/kisna/meetings/${String(id)}/original`,
    },
  });
  await enqueue({ meetingId: id, stage: 'ingest' });
  return id;
}

/** pyannote's view of the fixture: SPEAKER_00 for the even fake turns, SPEAKER_01 for the odd ones. */
const diarization = () => {
  const segs = turnsCovering(0, 120).map((t, i) => ({
    speaker: i % 2 ? 'SPEAKER_01' : 'SPEAKER_00',
    start: t.start,
    end: t.end,
  }));
  return { diarization: segs, exclusiveDiarization: segs };
};
const succeeded = () => ({ jobId: 'x', status: 'succeeded', output: diarization() });
const running = () => ({ jobId: 'x', status: 'running' });

async function runner() {
  return new Runner(
    testDeps({
      storage: await fakeStorage(),
      engine: () =>
        fakeEngine((input) => okResult(turnsCovering(0, input.endSec - input.startSec))),
      summariser: fakeSummariser(),
      speakerSource: 'pyannote',
    }),
    stages,
  );
}

/** Drain, then let jobs that are waiting (pyannote polls) run again, until nothing is left. */
async function drainAll(r: Runner, rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await r.drain();
    const waiting = await JobModel.updateMany(
      { status: 'queued' },
      { $set: { runAfter: new Date(0) } },
    );
    if (!waiting.modifiedCount) return;
  }
}

describe('speakers in the pipeline (pyannote mocked)', () => {
  it('diarizes beside transcription, joins at assembly, then names and summarises', async () => {
    let polls = 0;
    pya.getJob = () => (++polls < 2 ? running() : succeeded());
    const r = await runner();
    const id = await createMeeting();

    await r.drain();
    // transcription finished but assembly waits for pyannote
    let m = await MeetingModel.findById(id).lean();
    let data = await MeetingDataModel.findOne({ meetingId: id }).lean();
    expect(m?.stage).toBe('transcribe');
    expect(data?.diarize?.state).toBe('pending');
    expect(data?.chunks.every((c) => c.status === 'done')).toBe(true);

    await drainAll(r);
    m = await MeetingModel.findById(id).lean();
    data = await MeetingDataModel.findOne({ meetingId: id }).lean();
    expect(m?.status).toBe('completed');
    expect(data?.diarize).toMatchObject({ state: 'done', jobId: 'job-1' });
    expect(data?.speakerSource).toBe('pyannote');
    expect(Object.keys(data?.speakerMap ?? {}).sort()).toEqual([
      'SPEAKER_00',
      'SPEAKER_01',
      'unknown',
    ]);
    expect(data?.speakerMap['SPEAKER_00']).toBe('Speaker A');
    expect(data?.turns.every((t) => /^SPEAKER_0[01]$|^unknown$/.test(t.speaker))).toBe(true);
    expect(data?.lines.every((l) => l.end - l.start <= 45)).toBe(true);
    expect(new Set(data?.lines.map((l) => l.speakerName))).toEqual(
      new Set(['Speaker A', 'Speaker B']),
    );
    expect(data?.speakerCards.map((c) => c.diar).sort()).toEqual(['SPEAKER_00', 'SPEAKER_01']);
    expect(m?.coverage?.ratio).toBeGreaterThan(0.9);
    // Phase 1's text-linked version is kept for comparison
    expect(data?.phase1?.speakerMap).toEqual({ S1: 'Speaker 1', S2: 'Speaker 2' });
    expect(pya.submits).toBe(1);
    expect(pya.uploads).toEqual([`p2-${String(id)}.flac`]);
    const stored = await P2PyannoteResponseModel.findOne({ meetingId: id }).lean();
    expect(stored).toMatchObject({
      status: 'succeeded',
      tag: 'pipeline',
      keyLabel: 'PYANNOTEAI_API_KEY',
    });
  });

  it('submits again when pyannote no longer has the result (expired)', async () => {
    pya.getJob = (jobId) => {
      if (jobId === 'job-1') throw new PyannoteError('gone', 404);
      return succeeded();
    };
    const r = await runner();
    const id = await createMeeting();
    await drainAll(r);

    const data = await MeetingDataModel.findOne({ meetingId: id }).lean();
    expect(pya.submits).toBe(2);
    expect(data?.diarize).toMatchObject({ state: 'done', jobId: 'job-2' });
    const docs = await P2PyannoteResponseModel.find({ meetingId: id })
      .sort({ submittedAt: 1 })
      .lean();
    expect(docs.map((d) => [d.jobId, d.status])).toEqual([
      ['job-1', 'expired'],
      ['job-2', 'succeeded'],
    ]);
    expect((await MeetingModel.findById(id).lean())?.status).toBe('completed');
  });

  it('does not trust a job older than 24 h and resubmits instead of polling it', async () => {
    pya.getJob = () => succeeded();
    const r = await runner();
    const id = await createMeeting();
    // the worker was down for a day: a submitted job is already past pyannote's retention
    await P2PyannoteResponseModel.create({
      meetingId: id,
      kind: 'diarize',
      model: 'precision-2',
      tag: 'pipeline',
      jobId: 'old-job',
      status: 'running',
      submittedAt: new Date(Date.now() - 25 * 3600_000),
      keyLabel: 'PYANNOTEAI_API_KEY',
    });
    await drainAll(r);

    expect(pya.polls).not.toContain('old-job');
    expect(pya.submits).toBe(1);
    const old = await P2PyannoteResponseModel.findOne({ jobId: 'old-job' }).lean();
    expect(old?.status).toBe('expired');
    expect((await MeetingDataModel.findOne({ meetingId: id }).lean())?.diarize?.state).toBe('done');
  });

  it('keeps going with Phase 1 text linking when pyannote refuses (no credit)', async () => {
    pya.submit = async () => {
      throw new PyannoteError('Insufficient credits and no active subscription', 402);
    };
    const r = await runner();
    const id = await createMeeting();
    await drainAll(r);

    const m = await MeetingModel.findById(id).lean();
    const data = await MeetingDataModel.findOne({ meetingId: id }).lean();
    expect(m?.status).toBe('completed');
    expect(m?.summaryStatus).toBe('completed');
    expect(data?.diarize?.state).toBe('fallback');
    expect(data?.diarize?.reason).toMatch(/credits/);
    expect(data?.speakerSource).toBe('text-fallback');
    expect(data?.speakerMap).toEqual({ S1: 'Speaker 1', S2: 'Speaker 2' });
    expect(data?.speakerCards).toEqual([]);
  });

  it('retries a rate-limited submission instead of falling back', async () => {
    let first = true;
    pya.submit = async () => {
      if (first) {
        first = false;
        throw new PyannoteError('slow down', 429);
      }
      return 'job-ok';
    };
    pya.getJob = () => succeeded();
    const r = await runner();
    const id = await createMeeting();
    await drainAll(r);
    expect((await MeetingDataModel.findOne({ meetingId: id }).lean())?.diarize).toMatchObject({
      state: 'done',
      jobId: 'job-ok',
    });
  });

  it('retries after a network error instead of giving up on voices', async () => {
    let calls = 0;
    pya.submit = async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return 'job-after-blip';
    };
    pya.getJob = () => succeeded();
    const r = await runner();
    const id = await createMeeting();
    await drainAll(r);
    expect((await MeetingDataModel.findOne({ meetingId: id }).lean())?.diarize).toMatchObject({
      state: 'done',
      jobId: 'job-after-blip',
    });
  });

  it('leaves the text-only pipeline untouched when speakers are not requested', async () => {
    const r = new Runner(
      testDeps({
        storage: await fakeStorage(),
        engine: () =>
          fakeEngine((input) => okResult(turnsCovering(0, input.endSec - input.startSec))),
        summariser: fakeSummariser(),
      }),
      stages,
    );
    const id = await createMeeting();
    await drainAll(r);
    const data = await MeetingDataModel.findOne({ meetingId: id }).lean();
    expect(data?.diarize?.state).toBe('off');
    expect(data?.speakerSource).toBe('text-fallback');
    expect(pya.submits).toBe(0);
    expect((await MeetingModel.findById(id).lean())?.status).toBe('completed');
  });
});
