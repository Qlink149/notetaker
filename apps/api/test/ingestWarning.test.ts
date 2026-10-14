import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MeetingModel, type WorkspaceDoc } from '../src/models/index.js';
import { meetingView } from '../src/lib/views.js';
import { enqueue } from '../src/pipeline/queue.js';
import { Runner } from '../src/pipeline/runner.js';
import { stages } from '../src/pipeline/stages/index.js';
import * as ffmpeg from '../src/services/audio/ffmpeg.js';
import {
  clearDb,
  fakeEngine,
  fakeStorage,
  makeFixture,
  okResult,
  seedWorkspace,
  startDb,
  stopDb,
  testDeps,
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

async function ingest(declaredSec: number | null) {
  const base = testDeps({
    storage: await fakeStorage(),
    engine: () => fakeEngine(() => okResult([])),
  });
  const deps = {
    ...base,
    audio: {
      ...base.audio,
      // the file claims a different length than what could be read from it
      probe: async (path: string) => {
        const real = await ffmpeg.probe(path);
        return declaredSec !== null && path.endsWith('original')
          ? { ...real, durationSec: declaredSec }
          : real;
      },
    },
  };
  const id = new Types.ObjectId();
  await MeetingModel.create({
    _id: id,
    workspaceId: workspace._id,
    title: 'warn',
    status: 'processing',
    stage: 'ingest',
    engine: 'gemini',
    languages: ['hi'],
    audio: {
      originalUrl: fixture,
      originalPublicId: `workspaces/kisna/meetings/${String(id)}/original`,
    },
  });
  await enqueue({ meetingId: id, stage: 'ingest' });
  await new Runner(deps, stages).runOnce({ only: ['ingest'] });
  return (await MeetingModel.findById(id).lean())!;
}

describe('a recording that could only be read in part', () => {
  it('says so on the meeting, with both lengths', async () => {
    const m = await ingest(600); // declared 10:00, the fixture is 2:00
    expect(m.audioWarning).toContain('10:00 long');
    expect(m.audioWarning).toContain('only 2:00');
    expect(meetingView(m as never).audioWarning).toBe(m.audioWarning);
  });

  it('says nothing for a normal recording', async () => {
    const m = await ingest(null);
    expect(m.audioWarning ?? null).toBeNull();
    expect(meetingView(m as never).audioWarning).toBeNull();
  });
});
