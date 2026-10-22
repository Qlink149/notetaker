import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobModel } from '../src/models/index.js';
import { activeWork } from '../src/pipeline/queue.js';
import { clearDb, startDb, stopDb } from './helpers.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

const job = (x: object) =>
  JobModel.create({ meetingId: new Types.ObjectId(), stage: 'transcribe', step: 0, ...x });

describe('is the worker busy? (a deploy waits until it is not)', () => {
  it('is idle with no meeting work, done or failed jobs, or only a benchmark', async () => {
    await job({ status: 'done' });
    await job({ status: 'failed' });
    await job({ stage: 'benchmark', status: 'running', step: null });
    expect(await activeWork()).toEqual({ running: 0, due: 0 });
  });

  it('counts running jobs and queued jobs due within two minutes', async () => {
    const now = new Date();
    await job({ status: 'running' });
    await job({ status: 'queued', runAfter: now });
    await job({ status: 'queued', runAfter: new Date(now.getTime() + 60_000) });
    // waiting out a provider's credit pause (15 min): the new worker picks it up, no need to wait for it
    await job({ status: 'queued', runAfter: new Date(now.getTime() + 15 * 60_000) });
    expect(await activeWork(now)).toEqual({ running: 1, due: 2 });
  });
});
