import type { Segment, Turn } from '@meetingid/shared';
import { computeCoverage } from '../coverage.js';
import type { DiarSegment } from '../diarization.js';
import { UNKNOWN_SPEAKER, type JoinResult, type TimedWord } from './types.js';
import { assignByOverlap } from './m1.js';
import { assignWordSpeakers, wordClockJoin, type WordClockStats } from './m3.js';

export interface ChunkSpan {
  index: number;
  startSec: number;
  endSec: number;
}

export type JoinMethod = 'm1' | 'm3';

export interface ChunkDecision {
  index: number;
  startSec: number;
  endSec: number;
  /** Deepgram coverage of the speech in this chunk (0 when there are no Deepgram words). */
  deepgramCoverage: number;
  method: JoinMethod;
}

/** Deepgram coverage required to use M3 (DECISIONS: M3 when ≥ 0.70, else M1). */
export const M3_MIN_COVERAGE = 0.7;

/**
 * Each chunk owns the time up to the middle of its overlap with the next chunk, so a turn belongs
 * to exactly one chunk. Returns [ownStart, ownEnd) per chunk.
 */
export function chunkOwnership(chunks: ChunkSpan[]): { index: number; from: number; to: number }[] {
  const sorted = [...chunks].sort((a, b) => a.startSec - b.startSec);
  return sorted.map((c, i) => {
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    return {
      index: c.index,
      from: prev ? (c.startSec + prev.endSec) / 2 : -Infinity,
      to: next ? (next.startSec + c.endSec) / 2 : Infinity,
    };
  });
}

/** Per chunk, whether Deepgram's words cover enough of the detected speech to use M3. */
export function chooseMethods(
  chunks: ChunkSpan[],
  dgWords: TimedWord[],
  speechSegments: Segment[],
  minCoverage = M3_MIN_COVERAGE,
): ChunkDecision[] {
  return chunks.map((c) => {
    const speech = speechSegments
      .map((s) => ({ start: Math.max(s.start, c.startSec), end: Math.min(s.end, c.endSec) }))
      .filter((s) => s.end > s.start);
    const words = dgWords.filter((w) => w.start >= c.startSec - 1 && w.end <= c.endSec + 1);
    const asTurns: Turn[] = words.map((w) => ({
      speaker: 'dg',
      start: w.start,
      end: w.end,
      textNative: w.text,
      textRoman: w.text,
      lang: 'mixed',
    }));
    const deepgramCoverage = speech.length ? computeCoverage(speech, asTurns, 1).ratio : 0;
    return {
      index: c.index,
      startSec: c.startSec,
      endSec: c.endSec,
      deepgramCoverage,
      method: deepgramCoverage >= minCoverage ? 'm3' : 'm1',
    };
  });
}

export interface MeetingJoin {
  turns: Turn[];
  decisions: ChunkDecision[];
  /** Share of Gemini words given the same pyannote speaker by M1 and M3 (all words, and per chunk). */
  agreement: {
    overall: number | null;
    perChunk: { index: number; agreement: number | null; words: number }[];
  };
  m3Stats: WordClockStats | null;
}

/** Share of equal entries across two per-turn token-speaker arrays. */
function agreementOf(
  a: string[][],
  b: string[][],
  turnIdx: number[],
): { share: number | null; words: number } {
  let same = 0;
  let total = 0;
  for (const i of turnIdx) {
    const x = a[i]!;
    const y = b[i]!;
    const n = Math.min(x.length, y.length);
    for (let k = 0; k < n; k++) {
      total++;
      if (x[k] === y[k]) same++;
    }
  }
  return { share: total ? Math.round((same / total) * 1000) / 1000 : null, words: total };
}

/**
 * Join a meeting's Gemini turns to pyannote speakers. M1 and M3 are both computed; each turn takes
 * the method chosen for the chunk that owns it (M3 where Deepgram covers ≥ 0.70 of the speech).
 * Where the two disagree M3 wins, because it uses real word times. Output turns carry pyannote ids.
 */
export function joinMeeting(input: {
  turns: Turn[];
  chunks: ChunkSpan[];
  segments: DiarSegment[];
  dgWords: TimedWord[];
  speechSegments: Segment[];
  minCoverage?: number;
}): MeetingJoin {
  const { turns, chunks, segments, speechSegments } = input;
  const decisions = chooseMethods(chunks, input.dgWords, speechSegments, input.minCoverage);
  const m1 = assignByOverlap(turns, segments);
  const dgWords = assignWordSpeakers(input.dgWords, segments);
  const useM3 = decisions.some((d) => d.method === 'm3') && dgWords.length > 0;
  const m3: (JoinResult & { stats: WordClockStats }) | null = useM3
    ? wordClockJoin(turns, dgWords)
    : null;

  const owner = chunkOwnership(chunks);
  const methodFor = (t: Turn): JoinMethod => {
    const o = owner.find((c) => t.start >= c.from && t.start < c.to) ?? owner[owner.length - 1];
    return decisions.find((d) => d.index === o?.index)?.method ?? 'm1';
  };

  const out: Turn[] = [];
  const turnsByChunk = new Map<number, number[]>();
  turns.forEach((t, i) => {
    const method = m3 ? methodFor(t) : 'm1';
    const src = method === 'm3' && m3 ? m3 : m1;
    src.turns.forEach((o, k) => {
      if (src.sourceIndex[k] === i) out.push(o);
    });
    const o = owner.find((c) => t.start >= c.from && t.start < c.to) ?? owner[owner.length - 1];
    if (o) turnsByChunk.set(o.index, [...(turnsByChunk.get(o.index) ?? []), i]);
  });

  const all = turns.map((_, i) => i);
  const overall = m3 ? agreementOf(m1.tokenSpeakers, m3.tokenSpeakers, all).share : null;
  const perChunk = [...turnsByChunk].map(([index, idx]) => {
    const a = m3 ? agreementOf(m1.tokenSpeakers, m3.tokenSpeakers, idx) : { share: null, words: 0 };
    return { index, agreement: a.share, words: a.words };
  });
  return {
    turns: out.sort((a, b) => a.start - b.start),
    decisions,
    agreement: { overall, perChunk },
    m3Stats: m3?.stats ?? null,
  };
}

/** `Speaker A, B, C…` by speaking time, largest first; pyannote ids without speech are not listed. */
export function labelSpeakersByTime(
  segments: { speaker: string; start: number; end: number }[],
): Record<string, string> {
  const time = new Map<string, number>();
  for (const s of segments) time.set(s.speaker, (time.get(s.speaker) ?? 0) + (s.end - s.start));
  const letter = (i: number): string =>
    i < 26
      ? String.fromCharCode(65 + i)
      : letter(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26));
  const map: Record<string, string> = {};
  [...time].sort((a, b) => b[1] - a[1]).forEach(([id], i) => (map[id] = `Speaker ${letter(i)}`));
  map[UNKNOWN_SPEAKER] = 'Unknown';
  return map;
}
