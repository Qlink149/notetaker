import { MeetingDataModel, MeetingModel } from '../../models/index.js';
import type { StageContext, StageHandler } from '../context.js';
import { loadMeeting } from '../meetings.js';
import { MIN_COVERAGE } from './40-summarise.js';

/**
 * Final status: `partial` when coverage is below the gate or any chunk failed, else `completed`.
 * Gemini files are deleted best-effort (they would expire in 48 h anyway).
 */
export const finaliseStage: StageHandler = {
  async run({ job, deps, log }: StageContext) {
    const meeting = await loadMeeting(job.meetingId);
    const data = await MeetingDataModel.findOne(
      { meetingId: meeting._id },
      {
        'chunks.index': 1,
        'chunks.status': 1,
        'chunks.geminiFileName': 1,
        'chunks.geminiKeyId': 1,
      },
    ).lean();
    const chunks = data?.chunks ?? [];
    const failedChunks = chunks.filter((c) => c.status === 'failed').length;
    const ratio = meeting.coverage?.ratio ?? 0;
    const status = ratio < MIN_COVERAGE || failedChunks > 0 ? 'partial' : 'completed';

    await MeetingModel.updateOne(
      { _id: meeting._id },
      {
        $set: {
          status,
          stage: 'done',
          // Keep a summarise error visible (it carries a Retry); clear anything else.
          ...(meeting.error?.stage === 'summarise' ? {} : { error: null }),
        },
      },
    );

    let deleted = 0;
    for (const c of chunks) {
      if (!c.geminiFileName) continue;
      try {
        await deps.geminiFiles.delete(c.geminiFileName, c.geminiKeyId);
        deleted++;
      } catch {
        // best effort
      }
    }
    if (deleted) {
      await MeetingDataModel.updateOne(
        { meetingId: meeting._id },
        {
          $set: {
            'chunks.$[].geminiFileUri': null,
            'chunks.$[].geminiFileName': null,
            'chunks.$[].uploadedAt': null,
          },
        },
      );
    }
    const final = await MeetingModel.findById(meeting._id, { cost: 1 }).lean();
    log.info({ status, ratio, failedChunks, cost: final?.cost }, 'meeting finalised');
  },
};
