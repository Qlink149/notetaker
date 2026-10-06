import { assembleChunks, computeCoverage, turnsToLines } from '@meetingid/pipeline';
import type { Turn } from '@meetingid/shared';
import { MeetingDataModel, MeetingModel } from '../../models/index.js';
import type { StageContext, StageHandler } from '../context.js';
import { FatalError } from '../errors.js';
import { loadMeeting } from '../meetings.js';
import { enqueue } from '../queue.js';

export const MAX_LINE_SEC = 45;
export const PAUSE_SEC = 1.2;

/** Link speakers across chunks, merge seams, build ≤45 s lines, measure coverage. */
export const assembleStage: StageHandler = {
  async run({ job, deps, log }: StageContext) {
    const meeting = await loadMeeting(job.meetingId);
    const data = await MeetingDataModel.findOne({ meetingId: meeting._id }).lean();
    if (!data) throw new FatalError('Meeting data missing; re-run ingest');

    const done = data.chunks.filter((c) => c.status === 'done');
    const { turns, speakerCount } = assembleChunks(
      done.map((c) => ({ startSec: c.startSec, endSec: c.endSec, turns: c.rawTurns as Turn[] })),
    );
    const resolution = await deps.resolver.resolve({
      turns,
      analysisUrl: meeting.audio.analysisUrl ?? null,
    });
    const lines = turnsToLines(turns, resolution.speakerMap, {
      maxLineSec: MAX_LINE_SEC,
      pauseSec: PAUSE_SEC,
    });
    const coverage = computeCoverage(data.speechSegments, turns);

    await MeetingDataModel.updateOne(
      { meetingId: meeting._id },
      { $set: { turns, lines, speakerMap: resolution.speakerMap } },
    );
    await MeetingModel.updateOne(
      { _id: meeting._id },
      {
        $set: {
          stage: 'summarise',
          coverage,
          participants: resolution.participants,
          unknownCount: resolution.unknownCount,
        },
      },
    );
    await enqueue({ meetingId: meeting._id, stage: 'summarise' });
    log.info(
      {
        chunks: done.length,
        failedChunks: data.chunks.filter((c) => c.status === 'failed').length,
        turns: turns.length,
        lines: lines.length,
        speakerCount,
        coverage,
      },
      'assembled',
    );
  },
};
