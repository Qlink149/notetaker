import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLimiter } from '../src/lib/limiter.js';
import {
  JobModel,
  MeetingDataModel,
  MeetingModel,
  type WorkspaceDoc,
} from '../src/models/index.js';
import { ensureAnalysisFlac } from '../src/pipeline/chunkAudio.js';
import { RetryableError } from '../src/pipeline/errors.js';
import { claimNext, enqueue } from '../src/pipeline/queue.js';
import { Runner } from '../src/pipeline/runner.js';
import { stages } from '../src/pipeline/stages/index.js';
import type { StageRegistry } from '../src/pipeline/context.js';
import type {
  ChunkInput,
  ChunkResult,
  TranscriptionEngine,
} from '../src/services/engines/types.js';
import {
  clearDb,
  fakeStorage,
  makeFixture,
  okResult,
  seedWorkspace,
  startDb,
  stopDb,
  testDeps,
  turnsCovering,
} from './helpers.js';
import * as ffmpeg from '../src/services/audio/ffmpeg.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

describe('limiter', () => {
  it('never runs more than the cap at once and lets everything finish in order', async () => {
    const limit = createLimiter(3);
    let now = 0;
    let peak = 0;
    const started: number[] = [];
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limit.run(async () => {
          started.push(i);
          peak = Math.max(peak, ++now);
          await sleep(15);
          now--;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(limit.active).toBe(0);
    expect(limit.waiting).toBe(0);
  });

  it('frees the slot when a task throws', async () => {
    const limit = createLimiter(1);
    await expect(limit.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limit.run(async () => 'next')).resolves.toBe('next');
    expect(limit.active).toBe(0);
  });
});

describe('queue lanes', () => {
  it('lets one lane take only transcription and the other everything else', async () => {
    const meetingId = new Types.ObjectId();
    await enqueue({ meetingId, stage: 'transcribe', step: 0 });
    await enqueue({ meetingId, stage: 'gapfill' });

    const heavy = await claimNext('w', new Date(), { except: ['transcribe'] });
    expect(heavy?.stage).toBe('gapfill');
    expect(await claimNext('w', new Date(), { except: ['transcribe'] })).toBeNull();

    const chunk = await claimNext('w', new Date(), { only: ['transcribe'] });
    expect(chunk?.stage).toBe('transcribe');
    expect(await claimNext('w', new Date(), { only: ['transcribe'] })).toBeNull();
  });

  it('only reclaims an abandoned job from the lane that owns its stage', async () => {
    const meetingId = new Types.ObjectId();
    await enqueue({ meetingId, stage: 'transcribe', step: 0 });
    const dead = await claimNext('dead-worker', new Date());
    expect(dead?.stage).toBe('transcribe');
    const later = new Date(Date.now() + 3_600_000); // an hour on, far past the 8 minute lease
    expect(await claimNext('w', later, { except: ['transcribe'] })).toBeNull();
    expect((await claimNext('w', later, { only: ['transcribe'] }))?.stage).toBe('transcribe');
  });

  it('with no lane given still claims anything (unchanged behaviour)', async () => {
    await enqueue({ meetingId: new Types.ObjectId(), stage: 'transcribe', step: 0 });
    expect((await claimNext('w'))?.stage).toBe('transcribe');
  });
});

describe('runner lanes', () => {
  it('runs chunks in parallel up to the lane size while other stages are never blocked behind them', async () => {
    let transcribing = 0;
    let peakTranscribing = 0;
    let ingestRanWhileTranscribing = false;
    const ran: string[] = [];
    const registry = {
      ...stages,
      transcribe: {
        async run() {
          ran.push('transcribe');
          peakTranscribing = Math.max(peakTranscribing, ++transcribing);
          await sleep(500);
          transcribing--;
        },
      },
      ingest: {
        async run() {
          ran.push('ingest');
          // wait until a chunk is being transcribed (the lanes start independently under load)
          for (let i = 0; i < 100 && transcribing === 0; i++) await sleep(20);
          if (transcribing > 0) ingestRanWhileTranscribing = true;
        },
      },
    } as unknown as StageRegistry;

    for (let i = 0; i < 6; i++)
      await enqueue({ meetingId: new Types.ObjectId(), stage: 'transcribe', step: i });
    await sleep(5);
    await enqueue({ meetingId: new Types.ObjectId(), stage: 'ingest' });

    const runner = new Runner(
      testDeps({ storage: await fakeStorage(), engine: () => ({}) as never }),
      registry,
      { workerId: 'lanes', concurrency: 1, transcribeConcurrency: 3 },
    );
    const done = runner.start();
    for (let i = 0; i < 300 && ran.length < 7; i++) await sleep(50);
    for (let i = 0; i < 300 && (await JobModel.countDocuments({ status: { $ne: 'done' } })); i++)
      await sleep(50);
    await runner.stop(5000);
    await done;

    expect(ran.filter((s) => s === 'transcribe')).toHaveLength(6);
    expect(peakTranscribing).toBe(3);
    expect(ingestRanWhileTranscribing).toBe(true);
    expect(await JobModel.countDocuments({ status: 'done' })).toBe(7);
  });

  it('with no transcription lane keeps the old one-lane behaviour', async () => {
    let running = 0;
    let peak = 0;
    const registry = {
      ...stages,
      transcribe: {
        async run() {
          peak = Math.max(peak, ++running);
          await sleep(60);
          running--;
        },
      },
    } as unknown as StageRegistry;
    for (let i = 0; i < 3; i++)
      await enqueue({ meetingId: new Types.ObjectId(), stage: 'transcribe', step: i });
    const runner = new Runner(
      testDeps({ storage: await fakeStorage(), engine: () => ({}) as never }),
      registry,
      { workerId: 'one', concurrency: 1 },
    );
    expect(await runner.drain()).toBe(3);
    expect(peak).toBe(1);
  });
});

describe('a meeting whose chunks finish together', () => {
  it('moves to assemble exactly once and ends complete', async () => {
    const id = new Types.ObjectId();
    await MeetingModel.create({
      _id: id,
      workspaceId: workspace._id,
      title: 'three chunks',
      status: 'processing',
      stage: 'transcribe',
      engine: 'gemini',
      languages: ['hi', 'gu', 'en'],
      durationSec: 120,
      progress: { chunksTotal: 3, chunksDone: 0 },
      audio: {
        originalUrl: fixture,
        originalPublicId: `workspaces/kisna/meetings/${String(id)}/original`,
      },
    });
    const chunk = (index: number, startSec: number, endSec: number) => ({
      index,
      startSec,
      endSec,
      audioUrl: null,
      audioPublicId: null,
      geminiFileUri: `gemini://file-${index}`,
      geminiFileName: `files/${index}`,
      geminiKeyId: 'k1',
      uploadedAt: new Date(),
      model: null,
      status: 'pending' as const,
      attempts: 0,
      parent: null,
      rawTurns: [],
      responseId: null,
    });
    await MeetingDataModel.create({
      meetingId: id,
      chunks: [chunk(0, 0, 40), chunk(1, 40, 80), chunk(2, 80, 120)],
      speechSegments: [{ start: 0, end: 120 }],
      turns: [],
      lines: [],
      speakerMap: {},
      speakerCards: [],
      speakerSource: 'text-fallback',
    });
    for (const i of [0, 1, 2]) await enqueue({ meetingId: id, stage: 'transcribe', step: i });

    let inFlight = 0;
    let peak = 0;
    const engine: TranscriptionEngine = {
      name: 'gemini',
      accepts: ['gemini-file'],
      async transcribeChunk(input) {
        peak = Math.max(peak, ++inFlight);
        await sleep(150);
        inFlight--;
        return okResult(turnsCovering(0, input.endSec - input.startSec));
      },
    };
    const runner = new Runner(
      testDeps({ storage: await fakeStorage(), engine: () => engine }),
      stages,
      { workerId: 'together', concurrency: 1, transcribeConcurrency: 3 },
    );
    const done = runner.start();
    for (let i = 0; i < 200 && (await MeetingModel.findById(id).lean())?.stage !== 'done'; i++)
      await sleep(50);
    await runner.stop(5000);
    await done;

    const m = await MeetingModel.findById(id).lean();
    expect(m?.status).toBe('completed');
    expect(peak).toBe(3);
    expect(m?.progress).toEqual({ chunksTotal: 3, chunksDone: 3 });
    expect(await JobModel.countDocuments({ meetingId: id, stage: 'assemble' })).toBe(1);
    expect(await JobModel.countDocuments({ meetingId: id, stage: 'summarise' })).toBe(1);
    expect(await JobModel.countDocuments({ status: 'failed' })).toBe(0);
    const data = await MeetingDataModel.findOne({ meetingId: id }).lean();
    expect(data?.chunks.every((c) => c.status === 'done')).toBe(true);
    expect(data?.lines.length).toBeGreaterThan(0);
  });
});

describe('analysis audio shared between parallel jobs', () => {
  it('fetches and converts the original once when the cache is cold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dedupe-'));
    let downloads = 0;
    let conversions = 0;
    const cacheDir = join(root, 'cache');
    await mkdir(cacheDir);
    const store = new Map<string, string>();
    const deps = {
      storage: {
        download: async (_url: string, dest: string) => {
          downloads++;
          await sleep(40);
          await writeFile(dest, 'original');
        },
      },
      audio: {
        toAnalysisFlac: async (_from: string, to: string) => {
          conversions++;
          await sleep(40);
          await writeFile(to, 'flac');
        },
      },
      analysisCache: {
        get: async (url: string) => store.get(url) ?? null,
        put: async (url: string, path: string) => {
          const kept = join(cacheDir, 'kept.flac');
          await writeFile(kept, 'flac');
          store.set(url, kept);
          void path;
          return kept;
        },
      },
    };
    const dirs = await Promise.all(
      [1, 2, 3, 4].map(async (i) => {
        const d = join(root, `job-${i}`);
        await mkdir(d);
        return d;
      }),
    );
    const paths = await Promise.all(
      dirs.map((d) => ensureAnalysisFlac(deps as never, d, 'b2://meeting/original')),
    );
    expect(downloads).toBe(1);
    expect(conversions).toBe(1);
    expect(new Set(paths).size).toBe(1);
    expect(paths[0]).toBe(join(cacheDir, 'kept.flac'));
  });
});

describe('analysis audio inside one job without a cache', () => {
  it('lets parallel tasks wait for one fetch instead of racing on the same files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'samejob-'));
    let downloads = 0;
    let conversions = 0;
    const deps = {
      storage: {
        download: async (_url: string, dest: string) => {
          downloads++;
          await sleep(40);
          await writeFile(dest, 'original');
        },
      },
      audio: {
        toAnalysisFlac: async (_from: string, to: string) => {
          conversions++;
          await sleep(40);
          await writeFile(to, 'flac');
        },
      },
    };
    const paths = await Promise.all(
      [1, 2, 3].map(() => ensureAnalysisFlac(deps as never, root, 'b2://other/original')),
    );
    expect(downloads).toBe(1);
    expect(conversions).toBe(1);
    expect(new Set(paths)).toEqual(new Set([join(root, 'analysis.flac')]));
  });
});

describe('gap fill in parallel', () => {
  // Speech in six 10 s bursts; the chunk call only returns the first, leaving five gaps.
  const silences = [
    { start: 10, end: 20 },
    { start: 30, end: 40 },
    { start: 50, end: 60 },
    { start: 70, end: 80 },
    { start: 90, end: 100 },
    { start: 110, end: 120 },
  ];

  async function run(gapReply: (input: ChunkInput, n: number) => Promise<ChunkResult | Error>) {
    let inFlight = 0;
    let peak = 0;
    let n = 0;
    const engine: TranscriptionEngine = {
      name: 'gemini',
      accepts: ['gemini-file'],
      async transcribeChunk(input) {
        if (input.audio.kind === 'gemini-file') return okResult(turnsCovering(0, 10));
        peak = Math.max(peak, ++inFlight);
        try {
          await sleep(600);
          const r = await gapReply(input, ++n);
          if (r instanceof Error) throw r;
          return r;
        } finally {
          inFlight--;
        }
      },
    };
    const deps = testDeps({
      storage: await fakeStorage(),
      engine: () => engine,
      audio: {
        ...testDeps({ storage: await fakeStorage(), engine: () => engine }).audio,
        detectSilences: async () => silences,
      },
    });
    const id = new Types.ObjectId();
    await MeetingModel.create({
      _id: id,
      workspaceId: workspace._id,
      title: 'gaps',
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
    const runner = new Runner(deps, stages, { workerId: 'gaps' });
    await runner.drain(40);
    return { id, peak: () => peak, calls: () => n, runner };
  }

  it('runs the gap calls at most three at a time, saves each result and finishes', async () => {
    const t = await run(async (input) => okResult(turnsCovering(0, input.endSec - input.startSec)));
    const data = await MeetingDataModel.findOne({ meetingId: t.id }).lean();
    expect(data?.gapFills).toHaveLength(5);
    expect(data?.gapFills.every((g) => g.status === 'done')).toBe(true);
    expect(t.peak()).toBeGreaterThan(1);
    expect(t.peak()).toBeLessThanOrEqual(3);
    const m = await MeetingModel.findById(t.id).lean();
    expect(m?.status).not.toBe('failed');
    expect(await JobModel.countDocuments({ status: 'failed' })).toBe(0);
  });

  it('keeps the gaps that finished and waits when one hits the quota, starting no new calls', async () => {
    const t = await run(async (input, n) =>
      n === 1
        ? new RetryableError('Gemini rate limit: slow down', 'quota', { retryAfterMs: 60_000 })
        : okResult(turnsCovering(0, input.endSec - input.startSec)),
    );
    const data = await MeetingDataModel.findOne({ meetingId: t.id }).lean();
    // the quota hit stopped the stage: at most the three calls already in flight were made, never all five
    expect(t.calls()).toBeLessThanOrEqual(3);
    // the ones that did finish were saved, and the stage is queued to try again later without failing the meeting
    expect(data?.gapFills.every((g) => g.status === 'done')).toBe(true);
    const job = await JobModel.findOne({ stage: 'gapfill' }).lean();
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(0); // waiting on a quota is not a used attempt
    expect((await MeetingModel.findById(t.id).lean())?.status).toBe('processing');
  });
});

void ffmpeg;
