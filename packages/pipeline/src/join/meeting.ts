import type { Segment, Turn } from '@meetingid/shared';
import { computeCoverage } from '../coverage.js';
import type { DiarSegment } from '../diarization.js';
import { UNKNOWN_SPEAKER, type TimedWord } from './types.js';
import { assignByOverlap } from './m1.js';
import { splitWords } from './tokens.js';
import {
  assignWordSpeakers,
  wordClockJoin,
  type TokenPlacement,
  type WordClockStats,
} from './m3.js';

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
  /** Per chunk: how much of the speech Deepgram's words cover (informational; see `turnMethods`). */
  decisions: ChunkDecision[];
  /** Share of Gemini words given the same pyannote speaker by M1 and M3 (all words, and per chunk). */
  agreement: {
    overall: number | null;
    perChunk: { index: number; agreement: number | null; words: number }[];
  };
  m3Stats: WordClockStats | null;
  /** Turns joined by the word clock and by time overlap, and how many matches were rejected as outliers. */
  turnMethods: { m3: number; m1: number; outliers: number };
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

/** A turn is "poorly anchored" below this many matched Deepgram words, or this share of its words. */
export const POOR_ANCHORS = 4;
export const POOR_SHARE = 0.3;
/**
 * A poorly anchored turn is shifted by Gemini's clock drift, interpolated between the nearest
 * anchored turns before and after it, when those two are at most SHIFT_MAX_GAP_SEC apart and their
 * drifts agree within SHIFT_MAX_DISAGREE_SEC. Otherwise the drift is unknown and the turn keeps
 * its own times. (Gemini's clock is often seconds to minutes out; settled on held-out Deepgram
 * blocks, see DECISIONS.)
 */
export const SHIFT_MAX_GAP_SEC = 80;
export const SHIFT_MAX_DISAGREE_SEC = 8;
/** A turn with at least this many matched words (and POOR_SHARE of its words) has a drift of its own (their median). */
const OWN_DRIFT_ANCHORS = POOR_ANCHORS;
/**
 * A turn whose own drift is more than this from both anchored neighbours and from the line
 * between them is an outlier: its matches are a few common words aligned to a distant spot, not
 * the real place.
 */
export const OUTLIER_SEC = 8;

/** Most adjacent turns that can form a spike of false matches (see turnTrust). */
const SPIKE_MAX_TURNS = 3;

/** Where `x` sits between `a` and `b` (0..1); null when Gemini's times are not in order there. */
function fraction(x: number, a: number, b: number): number | null {
  if (!(b > a) || x < a || x > b) return null;
  return (x - a) / (b - a);
}

const median = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;

export interface TurnTrust {
  anchors: number[];
  words: number[];
  poor: boolean[];
  /** Seconds to add to Gemini's times for the turn; 0 where unknown. */
  shift: number[];
  /** Whether `shift` rests on two agreeing anchored neighbours (or the turn's own anchors). */
  shiftKnown: boolean[];
  /** Turns whose matches were rejected as inconsistent with their neighbours. */
  outlier: boolean[];
}

/**
 * Per turn: matched Deepgram words, whether it is poorly anchored, and the drift of Gemini's clock
 * (Deepgram time of a matched word minus Gemini's even-pacing time for it, median per turn,
 * interpolated across turns without enough anchors).
 */
export function turnTrust(turns: Turn[], tokens: TokenPlacement[]): TurnTrust {
  const anchors: number[] = [];
  const words: number[] = [];
  const own: (number | null)[] = [];
  let at = 0;
  for (const t of turns) {
    const n = splitWords(t.textNative).length;
    words.push(n);
    const offs: number[] = [];
    for (let k = 0; k < n; k++) {
      const tok = tokens[at + k]!;
      if (tok.matched) offs.push(tok.start - (t.start + ((k + 0.5) / n) * (t.end - t.start)));
    }
    anchors.push(offs.length);
    offs.sort((x, y) => x - y);
    // Only a dense match counts: a few common words (aur, yeh, hai) align almost anywhere, and a run
    // of such false matches even agrees with its own neighbours.
    own.push(
      offs.length >= OWN_DRIFT_ANCHORS && offs.length / Math.max(1, n) >= POOR_SHARE
        ? median(offs)
        : null,
    );
    at += n;
  }
  const outlier = new Array<boolean>(turns.length).fill(false);
  const anchored = own.flatMap((o, i) => (o === null ? [] : [i]));
  const midOf = (i: number): number => (turns[i]!.start + turns[i]!.end) / 2;
  anchored.forEach((i, k) => {
    const prev = anchored[k - 1];
    const next = anchored[k + 1];
    // Drift is smooth (a steady stretch or a steep ramp: it agrees with the line between the
    // neighbours) or jumps at a chunk seam (it agrees with one neighbour). A false match, a few
    // common words aligned to a distant spot, agrees with none of the three.
    const candidates: number[] = [];
    if (prev !== undefined) candidates.push(own[prev]!);
    if (next !== undefined) candidates.push(own[next]!);
    if (prev !== undefined && next !== undefined) {
      const f = fraction(midOf(i), midOf(prev), midOf(next));
      if (f !== null) candidates.push(own[prev]! + f * (own[next]! - own[prev]!));
    }
    // with one neighbour only, a ramp cannot be told from a jump: be twice as lenient
    const tolerance = candidates.length === 1 ? 2 * OUTLIER_SEC : OUTLIER_SEC;
    if (candidates.length && candidates.every((c) => Math.abs(own[i]! - c) > tolerance))
      outlier[i] = true;
  });
  // Two or three adjacent false turns agree with each other, so the test above cannot see them: a
  // short stretch whose drift differs from both sides, where the two sides agree with each other, is
  // a spike, not a change in the clock (a real seam changes the drift and keeps it).
  const levels: { turns: number[]; level: number }[] = [];
  anchored.forEach((i) => {
    if (outlier[i]) return;
    const last = levels[levels.length - 1];
    if (last && Math.abs(own[i]! - last.level) <= OUTLIER_SEC) {
      last.turns.push(i);
      last.level = median(last.turns.map((j) => own[j]!));
    } else levels.push({ turns: [i], level: own[i]! });
  });
  levels.forEach((l, k) => {
    const before = levels[k - 1];
    const after = levels[k + 1];
    if (
      before &&
      after &&
      l.turns.length <= SPIKE_MAX_TURNS &&
      Math.abs(before.level - after.level) <= OUTLIER_SEC &&
      Math.abs(l.level - before.level) > OUTLIER_SEC
    )
      for (const i of l.turns) outlier[i] = true;
  });
  outlier.forEach((o, i) => {
    if (o) own[i] = null;
  });
  const mid = turns.map((t) => (t.start + t.end) / 2);
  const poor = turns.map(
    (_, i) =>
      outlier[i]! ||
      anchors[i]! < POOR_ANCHORS ||
      anchors[i]! / Math.max(1, words[i]!) < POOR_SHARE,
  );
  const shift = new Array<number>(turns.length).fill(0);
  const shiftKnown = new Array<boolean>(turns.length).fill(false);
  turns.forEach((_, i) => {
    if (own[i] !== null) {
      shift[i] = own[i]!;
      shiftKnown[i] = true;
      return;
    }
    let p = i - 1;
    while (p >= 0 && own[p] === null) p--;
    let n = i + 1;
    while (n < turns.length && own[n] === null) n++;
    if (p < 0 || n >= turns.length) return;
    if (
      mid[n]! - mid[p]! > SHIFT_MAX_GAP_SEC ||
      Math.abs(own[n]! - own[p]!) > SHIFT_MAX_DISAGREE_SEC
    )
      return;
    const f = fraction(mid[i]!, mid[p]!, mid[n]!);
    if (f === null) return;
    shift[i] = own[p]! + f * (own[n]! - own[p]!);
    shiftKnown[i] = true;
  });
  return { anchors, words, poor, shift, shiftKnown, outlier };
}

/**
 * Join a meeting's Gemini turns to pyannote speakers. Deepgram's word clock is the base for time
 * and speaker wherever Gemini's words can be matched to Deepgram's: Gemini's own times drift by
 * seconds to minutes, so the aligned words give both the right moment and the right voice. A turn
 * with too few matched words (Deepgram missed or garbled it) keeps Gemini's turn boundaries, which
 * mark speaker changes the word clock cannot see, and is joined by time overlap (M1) after being
 * shifted by the locally measured drift of Gemini's clock. Without Deepgram words every turn is M1.
 * Output turns carry pyannote ids.
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
  const dgWords = assignWordSpeakers(input.dgWords, segments);
  const m3 = dgWords.length > 0 ? wordClockJoin(turns, dgWords, { segments }) : null;
  const trust = m3 ? turnTrust(turns, m3.tokens) : null;
  const useM1 = turns.map((_, i) => !trust || trust.poor[i]!);
  // M1 on Gemini's turns, shifted by the drift where it is known
  const m1Input = turns.map((t, i) =>
    trust && useM1[i] && trust.shiftKnown[i]
      ? { ...t, start: t.start + trust.shift[i]!, end: t.end + trust.shift[i]! }
      : t,
  );
  const m1 = assignByOverlap(m1Input, segments);

  const out: Turn[] = [];
  turns.forEach((_, i) => {
    const src = useM1[i] || !m3 ? m1 : m3;
    src.turns.forEach((o, k) => {
      if (src.sourceIndex[k] === i) out.push(trust && useM1[i] ? { ...o, timeEstimated: true } : o);
    });
  });

  const owner = chunkOwnership(chunks);
  const turnsByChunk = new Map<number, number[]>();
  turns.forEach((t, i) => {
    const o = owner.find((c) => t.start >= c.from && t.start < c.to) ?? owner[owner.length - 1];
    if (o) turnsByChunk.set(o.index, [...(turnsByChunk.get(o.index) ?? []), i]);
  });
  const all = turns.map((_, i) => i);
  const overall = m3 ? agreementOf(m1.tokenSpeakers, m3.tokenSpeakers, all).share : null;
  const perChunk = [...turnsByChunk].map(([index, idx]) => {
    const a = m3 ? agreementOf(m1.tokenSpeakers, m3.tokenSpeakers, idx) : { share: null, words: 0 };
    return { index, agreement: a.share, words: a.words };
  });
  const m1Count = useM1.filter(Boolean).length;
  return {
    turns: out.sort((a, b) => a.start - b.start),
    decisions,
    agreement: { overall, perChunk },
    m3Stats: m3?.stats ?? null,
    turnMethods: {
      m3: turns.length - m1Count,
      m1: m1Count,
      outliers: trust ? trust.outlier.filter(Boolean).length : 0,
    },
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
