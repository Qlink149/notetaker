import {
  applyGapFills,
  assembleChunks,
  computeCoverage,
  joinMeeting,
  labelSpeakersByTime,
  repairRomanLeaks,
  turnsToLines,
  type SpeakerResolver,
} from '@meetingid/pipeline';
import type { Turn } from '@meetingid/shared';
import type { Types } from 'mongoose';
import { MeetingDataModel, MeetingModel, type MeetingDataDoc } from '../models/index.js';
import { applyNames } from '../services/identity/identity.js';
import type { JoinInput } from '../services/identity/joinInput.js';

export const MAX_LINE_SEC = 45;
export const PAUSE_SEC = 1.2;

/** A join may not lower coverage by more than rounding (Phase 2 rule: never below Phase 1's). */
const COVERAGE_TOLERANCE = 0.002;

/**
 * Build the meeting transcript from stored engine output (no engine calls): assemble the done
 * chunks, add any done gap fills, repair native-script leaks in the roman text, resolve speakers, build ≤45 s lines, measure coverage, and save.
 * Used by the assemble and gapfill stages and by `npm run reassemble`.
 *
 * With `join` (pyannote's segments, optionally Deepgram's words) the text-linked turns are
 * re-labelled with pyannote speakers (M1/M3 per chunk, DECISIONS #28), unless that would lower
 * coverage. Without it, or when it is rejected, speakers come from Phase 1's text linker and the
 * meeting is marked `text-fallback`.
 */
export async function rebuildTranscript(
  meeting: { _id: Types.ObjectId; audio: { analysisUrl?: string | null } },
  data: Pick<MeetingDataDoc, 'chunks' | 'gapFills' | 'speechSegments'>,
  resolver: SpeakerResolver,
  join: JoinInput | null = null,
) {
  const done = data.chunks.filter((c) => c.status === 'done');
  const assembled = assembleChunks(
    done.map((c) => ({ startSec: c.startSec, endSec: c.endSec, turns: c.rawTurns as Turn[] })),
  );
  const fills = (data.gapFills ?? []).filter((g) => g.status === 'done' && g.turns.length);
  const textTurns = repairRomanLeaks(
    fills.length ? applyGapFills(assembled.turns, fills) : assembled.turns,
  );
  const speakerCount = new Set(textTurns.map((t) => t.speaker)).size;
  const resolution = await resolver.resolve({
    turns: textTurns,
    analysisUrl: meeting.audio.analysisUrl ?? null,
  });
  const textCoverage = computeCoverage(data.speechSegments, textTurns);

  let turns = textTurns;
  let speakerMap = resolution.speakerMap;
  let participants = resolution.participants;
  let unknownCount = resolution.unknownCount;
  let speakerSource: 'pyannote' | 'text-fallback' = 'text-fallback';
  let joinInfo: { agreement: number | null; rejected: string | null } | null = null;
  if (join?.segments.length && textTurns.length) {
    const joined = joinMeeting({
      turns: textTurns,
      chunks: done.map((c) => ({ index: c.index, startSec: c.startSec, endSec: c.endSec })),
      segments: join.segments,
      dgWords: join.dgWords,
      speechSegments: data.speechSegments,
    });
    const joinedCoverage = computeCoverage(data.speechSegments, joined.turns);
    if (joinedCoverage.ratio >= textCoverage.ratio - COVERAGE_TOLERANCE) {
      turns = joined.turns;
      speakerMap = labelSpeakersByTime(join.segments);
      const names = [...new Set(turns.map((t) => speakerMap[t.speaker] ?? t.speaker))];
      participants = names.filter((n) => n !== 'Unknown');
      unknownCount = names.length - participants.length;
      speakerSource = 'pyannote';
      joinInfo = { agreement: joined.agreement.overall, rejected: null };
    } else {
      joinInfo = {
        agreement: null,
        rejected: `join coverage ${joinedCoverage.ratio} below text-linked ${textCoverage.ratio}`,
      };
    }
  }

  const lines = turnsToLines(turns, speakerMap, {
    maxLineSec: MAX_LINE_SEC,
    pauseSec: PAUSE_SEC,
  });
  const coverage = computeCoverage(data.speechSegments, turns);
  await MeetingDataModel.updateOne(
    { meetingId: meeting._id },
    {
      $set: {
        turns,
        lines,
        speakerMap,
        speakerSource,
        ...(speakerSource === 'pyannote'
          ? {
              phase1: {
                turns: textTurns,
                lines: turnsToLines(textTurns, resolution.speakerMap),
                speakerMap: resolution.speakerMap,
              },
            }
          : {}),
      },
    },
  );
  await MeetingModel.updateOne(
    { _id: meeting._id },
    { $set: { coverage, participants, unknownCount } },
  );
  // Speaker cards (people, edits) outlive a rebuild: show their names on the fresh lines.
  if (speakerSource === 'pyannote') await applyNames(String(meeting._id));
  return {
    turns,
    lines,
    coverage,
    speakerCount:
      speakerSource === 'pyannote' ? new Set(turns.map((t) => t.speaker)).size : speakerCount,
    seams: assembled.seams,
    chunks: done.length,
    speakerSource,
    join: joinInfo,
  };
}
