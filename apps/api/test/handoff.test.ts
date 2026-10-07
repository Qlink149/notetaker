import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HandoffModel } from '../src/models/index.js';
import { RetryableError } from '../src/pipeline/errors.js';
import { HandoffSummariser } from '../src/services/summary/handoff.js';
import { clearDb, startDb, stopDb } from './helpers.js';

const input = () => ({
  meetingId: new Types.ObjectId().toHexString(),
  lines: [
    {
      speakerName: 'Speaker 1',
      start: 0,
      end: 3,
      textRoman: 'Kisna ka plan dekho.',
      textNative: '',
    },
    { speakerName: 'Speaker 2', start: 3, end: 4, textRoman: 'haan ji.', textNative: '' },
  ],
  glossary: { entries: [{ term: 'Kisna', kind: 'company' as const, aliases: [] }] },
  languages: ['hi' as const],
  includeNative: false,
  model: 'claude-haiku-4-5-20251001',
});

const reply = (owner: string) =>
  JSON.stringify({
    summary_markdown: '## Overview\nPlan review.\n\n## Decisions\nNo explicit decisions were made.',
    action_items: [{ speaker_name: owner, text: 'Share the plan.' }],
  });

describe('HandoffSummariser', () => {
  beforeAll(startDb);
  afterAll(stopDb);
  beforeEach(clearDb);

  it('stores the exact prompt, waits without failing, then validates the submitted reply', async () => {
    const s = new HandoffSummariser();
    const inp = input();
    const first = await s.summarise(inp).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(RetryableError);
    expect((first as RetryableError).reason).toBe('waiting');

    const doc = await HandoffModel.findOne({ meetingId: inp.meetingId }).lean();
    expect(doc?.system).toContain('Never infer, guess or add a real identity');
    expect(doc?.system).toContain('Kisna');
    expect(doc?.user).toBe(
      'Transcript:\n[00:00] Speaker 1: Kisna ka plan dekho.\n[00:03] Speaker 2: haan ji.',
    );

    await HandoffModel.updateOne(
      { _id: doc!._id },
      { $set: { status: 'answered', response: reply('Speaker 1') } },
    );
    const r = await s.summarise(inp);
    expect(r.result?.actionItems).toEqual([{ speakerName: 'Speaker 1', text: 'Share the plan.' }]);
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('re-opens the request on an invalid reply, then gives up like the API path', async () => {
    const s = new HandoffSummariser();
    const inp = input();
    await s.summarise(inp).catch(() => undefined);
    const id = (await HandoffModel.findOne({ meetingId: inp.meetingId }).lean())!._id;

    await HandoffModel.updateOne(
      { _id: id },
      { $set: { status: 'answered', response: 'not json' } },
    );
    const second = await s.summarise(inp).catch((e: unknown) => e);
    expect((second as RetryableError).reason).toBe('waiting');
    expect((await HandoffModel.findById(id).lean())?.status).toBe('pending');

    await HandoffModel.updateOne(
      { _id: id },
      { $set: { status: 'answered', response: 'still not json' } },
    );
    const third = await s.summarise(inp);
    expect(third.result).toBeNull();
    expect(third.error).toContain('invalid JSON');
  });
});
