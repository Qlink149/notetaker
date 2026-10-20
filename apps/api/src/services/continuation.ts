import type { AudioPart } from '@meetingid/shared';
import {
  EngineResponseModel,
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  type MeetingDoc,
  type SpeakerCardDoc,
} from '../models/index.js';
import { P2JoinModel, P2MediaModel, P2PyannoteResponseModel } from '../models/phase2.js';
import { PENDING_CONCAT } from '../pipeline/stages/07-concat.js';
import { pyannoteSegments } from './identity/identity.js';
import { FORMER } from './identity/enroll.js';

/** Gap fills ending this close to the end of the earlier audio are redone (that stretch is transcribed again). */
const GAP_KEEP_BEFORE_END_SEC = 30;

/**
 * Add recordings to the end of a meeting (client request, 20 Oct: "add a continuation to an existing meeting
 * later"). The meeting's recording becomes part 1 (or keeps its parts) and the new files follow; the meeting
 * is then processed again from the join. What is paid for again is only what the new audio changes:
 *
 * - transcription: every 10-minute chunk of the earlier audio is kept; only the last one (whose end moves) and
 *   the new audio are transcribed (ingest keeps chunks by position);
 * - gap fills over the earlier audio are kept, except near its end;
 * - speaker analysis and voice identification run again on the whole recording (pyannote labels voices per
 *   run, so the new audio cannot be labelled on its own), and so does Deepgram's word clock;
 * - the summary is written again (it has to cover the new audio).
 *
 * Decisions people made about voices (names, links, confirmations) are kept and moved onto the new voice
 * labels by the times those voices spoke (`carriedCards`). Lines moved by hand are not kept: the lines are
 * rebuilt.
 */
export async function addContinuation(meeting: MeetingDoc, added: AudioPart[]): Promise<void> {
  const id = meeting._id;
  const endSec = meeting.durationSec ?? 0;

  // the earlier decisions and the voices they were made on, before the stored speaker analysis is retired
  const data = await MeetingDataModel.findOne(
    { meetingId: id },
    { speakerCards: 1, gapFills: 1 },
  ).lean();
  const pya = await pyannoteSegments(String(id));
  const cards = (data?.speakerCards ?? []) as SpeakerCardDoc[];
  const carryOver =
    pya && cards.length && endSec > 0
      ? {
          endSec,
          segments: pya.segments.map((s) => ({ speaker: s.speaker, start: s.start, end: s.end })),
          cards,
        }
      : null;

  // stored results made from the earlier recording: kept for the record, never reused
  await P2PyannoteResponseModel.updateMany(
    { meetingId: id, kind: { $in: ['diarize', 'identify'] } },
    [{ $set: { tag: { $concat: ['before-added-audio:', '$tag'] } } }],
    { updatePipeline: true },
  );
  await EngineResponseModel.updateMany(
    { meetingId: id, engine: 'deepgram', kind: 'words', error: null },
    { $set: { error: 'superseded: audio was added to the meeting' } },
  );
  await P2MediaModel.deleteMany({ meetingId: id, kind: 'meeting' });
  await P2JoinModel.deleteMany({ meetingId: id });
  // people made from this meeting keep their earlier voice label aside until identification maps it
  await SpeakerModel.updateMany(
    {
      'origin.meetingId': id,
      'origin.diar': { $not: new RegExp(`^${FORMER}`) },
    },
    [{ $set: { 'origin.diar': { $concat: [FORMER, '$origin.diar'] } } }],
    { updatePipeline: true },
  );

  const gapFills = (data?.gapFills ?? []).filter((g) => g.end <= endSec - GAP_KEEP_BEFORE_END_SEC);
  await MeetingDataModel.updateOne(
    { meetingId: id },
    { $set: { carryOver, gapFills, speakerCards: [], speakerMerges: [] } },
  );

  const before: AudioPart[] = meeting.audio.parts?.length
    ? meeting.audio.parts
    : [
        {
          publicId: meeting.audio.originalPublicId,
          url: meeting.audio.originalUrl,
          fileName: null,
          durationSec: endSec || null,
          offsetSec: 0,
        },
      ];
  await MeetingModel.updateOne(
    { _id: id },
    {
      $set: {
        'audio.originalUrl': PENDING_CONCAT,
        'audio.parts': [...before, ...added],
        status: 'processing',
        stage: 'ingest',
        error: null,
        summaryOutdated: false,
      },
    },
  );
}
