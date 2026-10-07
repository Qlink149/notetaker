import type { DiarSegment, TimedWord } from '@meetingid/pipeline';
import { EngineResponseModel } from '../../models/index.js';
import { deepgramWordList } from '../engines/deepgram.js';
import { pyannoteSegments } from './identity.js';

export interface JoinInput {
  /** pyannote's exclusive diarization. */
  segments: DiarSegment[];
  /** Deepgram's words with their own clock; empty when none were fetched (M1 only). */
  dgWords: TimedWord[];
}

/** What the join needs for a meeting, from stored output only; null when it was not diarized. */
export async function loadJoinInput(meetingId: string): Promise<JoinInput | null> {
  const pya = await pyannoteSegments(meetingId);
  if (!pya) return null;
  const stored = await EngineResponseModel.findOne({
    meetingId,
    engine: 'deepgram',
    kind: 'words',
    error: null,
  }).lean();
  const dgWords = stored
    ? deepgramWordList(stored.response as Parameters<typeof deepgramWordList>[0])
    : [];
  return { segments: pya.segments, dgWords };
}
