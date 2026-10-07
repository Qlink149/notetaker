import type { Turn } from '@meetingid/shared';

/** Speaker value for text no pyannote segment could be matched to. */
export const UNKNOWN_SPEAKER = 'unknown';

/** A word with a real clock time (Deepgram) and, once assigned, the pyannote speaker active at its midpoint. */
export interface TimedWord {
  text: string;
  start: number;
  end: number;
  speaker?: string | null;
}

/**
 * Result of joining Gemini's text to pyannote's speakers. `turns` carry pyannote speaker ids in
 * `speaker`; `tokenSpeakers[i]` is the speaker of each whitespace-separated native word of input turn i
 * (used to compare methods).
 */
export interface JoinResult {
  turns: Turn[];
  tokenSpeakers: string[][];
  /** For each output turn, the index of the input turn it came from. */
  sourceIndex: number[];
}

export function cutPoints(fractions: number[], n: number): number[] {
  // Word index where each piece ends, from the cumulative share of each piece.
  const total = fractions.reduce((a, b) => a + b, 0) || 1;
  let cum = 0;
  return fractions.map((f, i) => {
    cum += f;
    return i === fractions.length - 1 ? n : Math.round((cum / total) * n);
  });
}
