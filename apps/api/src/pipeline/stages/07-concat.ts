import { join } from 'node:path';
import { MeetingModel } from '../../models/index.js';
import type { StageContext, StageHandler } from '../context.js';
import { FatalError, humanizeError } from '../errors.js';
import { loadMeeting } from '../meetings.js';
import { enqueue } from '../queue.js';

/** Stored address of a meeting whose files are still being joined. */
export const PENDING_CONCAT = 'pending:concat';

/**
 * A meeting recorded in several files (client request, 20 Oct: "two or three batches of one meeting, condensed
 * into a single meeting"): convert each file the same way as a single upload (including the repair for iPhone
 * recordings), join them in order, store the result as the meeting's recording and hand it to the normal
 * pipeline. Each part's start in the combined recording is kept, so the transcript can mark where it begins.
 */
export const concatStage: StageHandler = {
  async run({ job, deps, log, tmpDir }: StageContext) {
    const meeting = await loadMeeting(job.meetingId);
    const parts = meeting.audio.parts ?? [];
    if (parts.length < 2) throw new FatalError('A meeting in parts needs at least two files.');

    const flacs: string[] = [];
    const lengths: number[] = [];
    const started = Date.now();
    for (const [i, part] of parts.entries()) {
      const src = join(tmpDir, `part-${i}`);
      const flac = join(tmpDir, `part-${i}.flac`);
      try {
        await deps.storage.download(part.url, src);
        await deps.audio.toAnalysisFlac(src, flac);
        lengths.push((await deps.audio.probe(flac)).durationSec);
      } catch (err) {
        const name = part.fileName ?? `part ${i + 1}`;
        throw Object.assign(err as Error, {
          message: `${name}: ${(err as Error).message}`,
        });
      }
      flacs.push(flac);
    }

    const combined = join(tmpDir, 'combined.flac');
    await deps.audio.concatFlac(flacs, combined);
    const folder = meeting.audio.originalPublicId.replace(/\/[^/]+$/, '');
    const stored = await deps.storage.uploadAudio(
      combined,
      `${folder}/combined-${parts.length}.flac`,
    );

    let offset = 0;
    const placed = parts.map((p, i) => {
      const at = { ...p, offsetSec: Math.round(offset * 1000) / 1000, durationSec: lengths[i]! };
      offset += lengths[i]!;
      return at;
    });
    await MeetingModel.updateOne(
      { _id: meeting._id },
      {
        $set: {
          'audio.originalUrl': stored.url,
          'audio.originalPublicId': stored.publicId,
          'audio.parts': placed,
          durationSec: Math.round(offset * 10) / 10,
          stage: 'ingest',
          status: 'processing',
          error: null,
        },
      },
    );
    log.info(
      { parts: parts.length, seconds: lengths.map((s) => Math.round(s)), ms: Date.now() - started },
      'parts joined',
    );
    await enqueue({ meetingId: meeting._id, stage: 'ingest' });
  },

  async onGiveUp({ job }: StageContext, error: Error) {
    await MeetingModel.updateOne(
      { _id: job.meetingId },
      {
        $set: {
          status: 'failed',
          error: { stage: 'ingest', message: humanizeError(error), retryable: true },
        },
      },
    );
  },
};
