import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { formatLinesForSummary, parseSummary } from '@meetingid/pipeline';
import { HandoffModel } from '../../models/index.js';
import { RetryableError } from '../../pipeline/errors.js';
import { buildSummarySystemPrompt, type Summariser, type SummaryInput } from './claude.js';

/** Replies that fail validation this many times end in `summaryStatus: failed`, like the API path. */
const MAX_REJECTIONS = 2;
const POLL_MS = 15_000;

/**
 * Testing-only summariser (SUMMARY_PROVIDER=handoff). It builds exactly the prompt the Anthropic
 * summariser sends, stores it in MongoDB and waits (without using job attempts) until an external
 * agent — an isolated Claude Haiku 4.5 subagent run by the developer — submits the raw reply with
 * `npm run handoff -- submit`. The reply goes through the same strict `parseSummary` validation.
 * The whole transcript is sent in one request (Haiku's context holds a 3-hour meeting).
 */
export class HandoffSummariser implements Summariser {
  async summarise(input: SummaryInput) {
    if (!input.meetingId) throw new Error('HandoffSummariser needs input.meetingId');
    const speakers = [...new Set(input.lines.map((l) => l.speakerName))];
    const system = buildSummarySystemPrompt(input, speakers);
    const user = `Transcript:\n${formatLinesForSummary(input.lines, { includeNative: input.includeNative })}`;
    const id = `${input.meetingId}:${createHash('sha1').update(system).update(user).digest('hex').slice(0, 10)}`;
    const usage = { inputTokens: 0, outputTokens: 0 };

    const doc = await HandoffModel.findById(id).lean();
    if (!doc) {
      await HandoffModel.create({
        _id: id,
        meetingId: new Types.ObjectId(input.meetingId),
        model: input.model,
        system,
        user,
      });
      throw new RetryableError(`Summary handed off as ${id}; waiting for the reply`, 'waiting', {
        retryAfterMs: POLL_MS,
      });
    }
    if (doc.status === 'pending' || !doc.response) {
      throw new RetryableError(`Waiting for handoff reply ${id}`, 'waiting', {
        retryAfterMs: POLL_MS,
      });
    }

    const parsed = parseSummary(doc.response, [...speakers, 'Unassigned']);
    if (parsed.ok) return { result: parsed.value, usage };
    if (doc.rejections + 1 >= MAX_REJECTIONS) {
      return { result: null, usage, error: parsed.error };
    }
    await HandoffModel.updateOne(
      { _id: id },
      {
        $set: { status: 'pending', response: null, lastError: parsed.error },
        $inc: { rejections: 1 },
      },
    );
    throw new RetryableError(
      `Handoff reply ${id} rejected (${parsed.error}); waiting for a new one`,
      'waiting',
      {
        retryAfterMs: POLL_MS,
      },
    );
  }
}
