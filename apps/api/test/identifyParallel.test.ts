import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// pyannote is mocked at its module boundary; identification, enrolment and the media reuse are the real code.
const pya = vi.hoisted(() => ({
  uploads: [] as string[],
  events: [] as { speaker: string; at: 'start' | 'end'; t: number }[],
}));

vi.mock('../src/services/pyannote/client.js', async () => {
  const real = await vi.importActual<Record<string, unknown>>('../src/services/pyannote/client.js');
  return {
    ...real,
    uploadMedia: vi.fn(async (_path: string, key: string) => {
      pya.uploads.push(key);
      return `media://${key}`;
    }),
    submitDiarize: vi.fn(async () => 'diarize-job'),
    submitVoiceprint: vi.fn(async (media: string) => {
      const speaker = /SPEAKER_\d+/.exec(media)?.[0] ?? '?';
      pya.events.push({ speaker, at: 'start', t: Date.now() });
      await sleep(250);
      pya.events.push({ speaker, at: 'end', t: Date.now() });
      return `vp-${speaker}-${pya.events.length}`;
    }),
    waitForJob: vi.fn(async (id: string) => ({
      jobId: id,
      status: 'succeeded',
      output: { voiceprint: `print-${id}` },
    })),
    getJob: vi.fn(async (id: string) => {
      if (id === 'diarize-job') return { jobId: id, status: 'succeeded', output: diarization() };
      return { jobId: id, status: 'succeeded', output: { voiceprint: `print-${id}` } };
    }),
  };
});

import {
  JobModel,
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  type WorkspaceDoc,
} from '../src/models/index.js';
import { P2MediaModel } from '../src/models/phase2.js';
import { enqueue } from '../src/pipeline/queue.js';
import { Runner } from '../src/pipeline/runner.js';
import { stages } from '../src/pipeline/stages/index.js';
import { analysisFlac, meetingMedia } from '../src/services/pyannote/jobs.js';
import { createAnalysisCache } from '../src/lib/analysisCache.js';
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

/** SPEAKER_00 for the even fake turns, SPEAKER_01 for the odd ones, over the 2-minute fixture. */
const diarization = () => {
  const segs = turnsCovering(0, 120).map((t, i) => ({
    speaker: i % 2 ? 'SPEAKER_01' : 'SPEAKER_00',
    start: t.start,
    end: t.end,
  }));
  return { diarization: segs, exclusiveDiarization: segs };
};

beforeAll(async () => {
  await startDb();
  fixture = await makeFixture(await mkdtemp(join(tmpdir(), 'fixture-')));
});
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  workspace = await seedWorkspace();
  pya.uploads.length = 0;
  pya.events.length = 0;
});

async function runPipeline() {
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
  const r = new Runner(
    testDeps({
      storage: await fakeStorage(),
      engine: () =>
        fakeEngine((input) => okResult(turnsCovering(0, input.endSec - input.startSec))),
      summariser: fakeSummariser(),
      speakerSource: 'pyannote',
      // as in the worker: ingest leaves the converted audio here for the later steps
      analysisCache: createAnalysisCache(),
    }),
    stages,
  );
  for (let i = 0; i < 12; i++) {
    await r.drain();
    const waiting = await JobModel.updateMany(
      { status: 'queued' },
      { $set: { runAfter: new Date(0) } },
    );
    if (!waiting.modifiedCount) break;
  }
  return id;
}

describe('voice identification reuses what speaker analysis already did', () => {
  it('uploads the meeting audio to pyannote once for both steps', async () => {
    const id = await runPipeline();
    expect((await MeetingModel.findById(id).lean())?.status).toBe('completed');
    const meetingUploads = pya.uploads.filter((k) => k.startsWith(`p2-${String(id)}-`));
    expect(meetingUploads).toHaveLength(1);
    // and identification finds that upload instead of sending the recording again
    const before = pya.uploads.length;
    const url = await meetingMedia(String(id));
    expect(url).toBe(`media://${meetingUploads[0]}`);
    expect(pya.uploads).toHaveLength(before);
    expect(await P2MediaModel.countDocuments({ meetingId: id, kind: 'meeting' })).toBe(1);
  });

  it('creates the voices voiceprints at the same time, not one voice after another', async () => {
    const id = await runPipeline();
    const people = await SpeakerModel.find({ workspaceId: workspace._id }).lean();
    expect(people.length).toBeGreaterThanOrEqual(2);
    expect(people.every((p) => p.voiceprints.length > 0)).toBe(true);
    const lastEnd = (s: string) =>
      Math.max(...pya.events.filter((e) => e.speaker === s && e.at === 'end').map((e) => e.t));
    const firstStart = (s: string) =>
      Math.min(...pya.events.filter((e) => e.speaker === s && e.at === 'start').map((e) => e.t));
    // the second voice started before the first voice had finished
    expect(firstStart('SPEAKER_01')).toBeLessThan(lastEnd('SPEAKER_00'));
    expect((await MeetingDataModel.findOne({ meetingId: id }).lean())?.speakerCards).toHaveLength(
      2,
    );
  });
});

describe('the audio copy used by identification', () => {
  it('comes from the shared cache the pipeline filled, not a new download and conversion', async () => {
    const id = new Types.ObjectId();
    const url = `local://cached-${String(id)}`;
    await MeetingModel.create({
      _id: id,
      workspaceId: workspace._id,
      title: 'cached',
      status: 'completed',
      stage: 'done',
      engine: 'gemini',
      languages: ['hi'],
      audio: {
        originalUrl: url,
        originalPublicId: `workspaces/kisna/meetings/${String(id)}/original`,
      },
    });
    const cached = await createAnalysisCache().put(url, fixture);
    expect(cached).not.toBeNull();
    const path = await analysisFlac(String(id));
    expect(path).toBe(cached);
  });
});
