import type { DiarSegment, TimedWord, WordClockSource } from '@meetingid/pipeline';
import { EngineResponseModel } from '../../models/index.js';
import { deepgramWordList } from '../engines/deepgram.js';
import { pyannoteSegments } from './identity.js';

export interface JoinInput {
  /** pyannote's exclusive diarization. */
  segments: DiarSegment[];
  /** Deepgram's words with their own clock (the first language fetched); empty when none were fetched (M1 only). */
  dgWords: TimedWord[];
  /** Every Deepgram word clock of the meeting, one per language ("hi", "gu"); the join picks per part. */
  dgSources: WordClockSource[];
}

/** What the join needs for a meeting, from stored output only; null when it was not diarized. */
export async function loadJoinInput(meetingId: string): Promise<JoinInput | null> {
  const pya = await pyannoteSegments(meetingId);
  if (!pya) return null;
  const stored = await EngineResponseModel.find({
    meetingId,
    engine: 'deepgram',
    kind: 'words',
    error: null,
  })
    .sort({ receivedAt: 1 })
    .lean();
  const dgSources = stored.map((s) => ({
    label: String(s.model ?? 'deepgram').replace(/^nova-3\//, ''),
    words: deepgramWordList(s.response as Parameters<typeof deepgramWordList>[0]),
  }));
  return { segments: pya.segments, dgWords: dgSources[0]?.words ?? [], dgSources };
}
