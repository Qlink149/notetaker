import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  JobModel,
  MeetingDataModel,
  MeetingModel,
  type WorkspaceDoc,
} from '../src/models/index.js';
import { enqueue } from '../src/pipeline/queue.js';
import { Runner } from '../src/pipeline/runner.js';
import { stages } from '../src/pipeline/stages/index.js';
import {
  clearDb,
  fakeEngine,
  fakeStorage,
  okResult,
  seedWorkspace,
  startDb,
  stopDb,
  testDeps,
} from './helpers.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let longAudio: string;
let workspace: WorkspaceDoc;

beforeAll(async () => {
  await startDb();
  // 25 minutes of tone: three chunks (0-10, 10-20, 20-25 min plus overlap)
  const dir = await mkdtemp(join(tmpdir(), 'long-'));
  longAudio = join(dir, 'long.wav');
  const bin = (createRequire(import.meta.url)('@ffmpeg-installer/ffmpeg') as { path: string }).path;
  const r = spawnSync(bin, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1500:sample_rate=8000',
    '-ac',
    '1',
    longAudio,
  ]);
  if (r.status !== 0) throw new Error(`fixture failed: ${r.stderr.toString()}`);
}, 120_000);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  workspace = await seedWorkspace();
});

async function newMeeting(): Promise<Types.ObjectId> {
  const id = new Types.ObjectId();
  await MeetingModel.create({
    _id: id,
    workspaceId: workspace._id,
    title: 'long',
    status: 'processing',
    stage: 'ingest',
    engine: 'gemini',
    languages: ['hi', 'gu', 'en'],
    audio: {
      originalUrl: longAudio,
      originalPublicId: `workspaces/kisna/meetings/${String(id)}/original`,
    },
  });
  await enqueue({ meetingId: id, stage: 'ingest' });
  return id;
}

describe('ingest overlaps cutting, uploading and transcription', () => {
  it('uploads chunks a few at a time and queues each one as soon as its audio is ready', async () => {
    const uploads: string[] = [];
    let inFlight = 0;
    let peak = 0;
    let queuedWhenLastUploadEnded = -1;
    const delays = [100, 100, 900];
    const base = testDeps({
      storage: await fakeStorage(),
      engine: () => fakeEngine(() => okResult([])),
    });
    const deps = {
      ...base,
      geminiFiles: {
        delete: async () => undefined,
        upload: async (_path: string, mime: string, name: string) => {
          const n = uploads.push(name);
          peak = Math.max(peak, ++inFlight);
          await sleep(delays[n - 1] ?? 100);
          inFlight--;
          if (n === 3)
            queuedWhenLastUploadEnded = await JobModel.countDocuments({ stage: 'transcribe' });
          return { uri: `gemini://f${n}`, name: `files/${n}`, mimeType: mime, keyId: 'k1' };
        },
      },
    };
    const id = await newMeeting();
    await new Runner(deps, stages).runOnce({ only: ['ingest'] });

    expect(uploads).toHaveLength(3);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    // the two quick chunks were already waiting for a worker while the slow one was still uploading
    expect(queuedWhenLastUploadEnded).toBe(2);
    const data = await MeetingDataModel.findOne({ meetingId: id }).lean();
    expect(data?.chunks).toHaveLength(3);
    expect(data?.chunks.every((c) => c.status === 'pending' && c.geminiFileUri)).toBe(true);
    expect(await JobModel.countDocuments({ meetingId: id, stage: 'transcribe' })).toBe(3);
    const m = await MeetingModel.findById(id).lean();
    expect(m?.progress).toEqual({ chunksTotal: 3, chunksDone: 0 });
    expect(m?.stage).toBe('transcribe');
  }, 60_000);

  it('on a re-run keeps a transcribed chunk and an uploaded one, and only redoes what is missing', async () => {
    const uploads: string[] = [];
    const base = testDeps({
      storage: await fakeStorage(),
      engine: () => fakeEngine(() => okResult([])),
    });
    const deps = {
      ...base,
      geminiFiles: {
        delete: async () => undefined,
        upload: async (_path: string, mime: string, name: string) => {
          uploads.push(name);
          return {
            uri: `gemini://new-${uploads.length}`,
            name: `files/n${uploads.length}`,
            mimeType: mime,
            keyId: 'k1',
          };
        },
      },
    };
    const id = await newMeeting();
    const runner = new Runner(deps, stages);
    await runner.runOnce({ only: ['ingest'] });
    // pretend the first attempt got as far as transcribing chunk 0, then failed
    const first = await MeetingDataModel.findOne({ meetingId: id }).lean();
    const turn = { speaker: 'S1', start: 1, end: 2, textNative: 'a', textRoman: 'a', lang: 'hi' };
    await MeetingDataModel.updateOne(
      { meetingId: id, 'chunks.index': 0 },
      { $set: { 'chunks.$.status': 'done', 'chunks.$.rawTurns': [turn] } },
    );
    await MeetingDataModel.updateOne(
      { meetingId: id, 'chunks.index': 2 },
      {
        $set: {
          'chunks.$.geminiFileUri': null,
          'chunks.$.geminiFileName': null,
          'chunks.$.uploadedAt': null,
        },
      },
    );
    await JobModel.deleteMany({ meetingId: id });
    uploads.length = 0;
    await enqueue({ meetingId: id, stage: 'ingest' });
    await runner.runOnce({ only: ['ingest'] });

    expect(first?.chunks).toHaveLength(3);
    expect(uploads).toHaveLength(1); // only chunk 2 lost its upload
    const data = await MeetingDataModel.findOne({ meetingId: id }).lean();
    expect(data?.chunks[0]?.status).toBe('done');
    expect(data?.chunks[0]?.rawTurns).toHaveLength(1);
    expect(data?.chunks[1]?.geminiFileUri).toBe(first?.chunks[1]?.geminiFileUri);
    expect(data?.chunks[2]?.geminiFileUri).toBe('gemini://new-1');
    const steps = (await JobModel.find({ meetingId: id, stage: 'transcribe' }).lean())
      .map((j) => j.step)
      .sort();
    expect(steps).toEqual([1, 2]); // the transcribed chunk is not queued again
    const m = await MeetingModel.findById(id).lean();
    expect(m?.progress).toEqual({ chunksTotal: 3, chunksDone: 1 });
  }, 60_000);
});
