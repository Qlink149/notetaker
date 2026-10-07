import { env } from '../../config/env.js';
import { MeetingDataModel, MeetingModel } from '../../models/index.js';
import type { StageContext, StageHandler } from '../context.js';
import { FatalError } from '../errors.js';
import { loadMeeting } from '../meetings.js';
import { enqueue } from '../queue.js';
import { loadJoinInput } from '../../services/identity/joinInput.js';
import { rebuildTranscript } from '../transcript.js';

export { MAX_LINE_SEC, PAUSE_SEC } from '../transcript.js';

/** Link speakers across chunks, merge seams, build ≤45 s lines, measure coverage. */
export const assembleStage: StageHandler = {
  async run({ job, deps, log }: StageContext) {
    const meeting = await loadMeeting(job.meetingId);
    const data = await MeetingDataModel.findOne({ meetingId: meeting._id }).lean();
    if (!data) throw new FatalError('Meeting data missing; re-run ingest');

    const join =
      deps.speakerSource === 'pyannote' ? await loadJoinInput(String(meeting._id)) : null;
    const built = await rebuildTranscript(meeting, data, deps.resolver, join);
    if (env().GAPFILL === 'off') {
      // no new engine calls: straight to naming the voices (or the summary for text-only meetings)
      await MeetingModel.updateOne({ _id: meeting._id }, { $set: { stage: 'summarise' } });
      await enqueue({
        meetingId: meeting._id,
        stage: deps.speakerSource === 'pyannote' ? 'identify' : 'summarise',
      });
    } else {
      await MeetingModel.updateOne({ _id: meeting._id }, { $set: { stage: 'gapfill' } });
      await enqueue({ meetingId: meeting._id, stage: 'gapfill' });
    }
    log.info(
      {
        chunks: built.chunks,
        failedChunks: data.chunks.filter((c) => c.status === 'failed').length,
        turns: built.turns.length,
        lines: built.lines.length,
        speakerCount: built.speakerCount,
        speakerSource: built.speakerSource,
        join: built.join,
        coverage: built.coverage,
      },
      'assembled',
    );
  },
};
