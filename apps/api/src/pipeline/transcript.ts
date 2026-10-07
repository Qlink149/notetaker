import {
  applyGapFills,
  assembleChunks,
  computeCoverage,
  repairRomanLeaks,
  turnsToLines,
  type SpeakerResolver,
} from '@meetingid/pipeline';
import type { Turn } from '@meetingid/shared';
import type { Types } from 'mongoose';
import { MeetingDataModel, MeetingModel, type MeetingDataDoc } from '../models/index.js';

export const MAX_LINE_SEC = 45;
export const PAUSE_SEC = 1.2;

/**
 * Build the meeting transcript from stored engine output (no engine calls): assemble the done
 * chunks, add any done gap fills, repair native-script leaks in the roman text, resolve speakers, build ≤45 s lines, measure coverage, and save.
 * Used by the assemble and gapfill stages and by `npm run reassemble`.
 */
export async function rebuildTranscript(
  meeting: { _id: Types.ObjectId; audio: { analysisUrl?: string | null } },
  data: Pick<MeetingDataDoc, 'chunks' | 'gapFills' | 'speechSegments'>,
  resolver: SpeakerResolver,
) {
  const done = data.chunks.filter((c) => c.status === 'done');
  const assembled = assembleChunks(
    done.map((c) => ({ startSec: c.startSec, endSec: c.endSec, turns: c.rawTurns as Turn[] })),
  );
  const fills = (data.gapFills ?? []).filter((g) => g.status === 'done' && g.turns.length);
  const turns = repairRomanLeaks(
    fills.length ? applyGapFills(assembled.turns, fills) : assembled.turns,
  );
  const speakerCount = new Set(turns.map((t) => t.speaker)).size;
  const resolution = await resolver.resolve({
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
        coverage,
        participants: resolution.participants,
        unknownCount: resolution.unknownCount,
      },
    },
  );
  return { turns, lines, coverage, speakerCount, seams: assembled.seams, chunks: done.length };
}
