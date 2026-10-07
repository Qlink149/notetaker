import type { Turn } from '@meetingid/shared';
import type { DiarSegment } from '../diarization.js';
import { alignTokens } from './alignTokens.js';
import { foldWord, splitWords } from './tokens.js';
import { cutPoints, type JoinResult, type TimedWord } from './types.js';

/**
 * Give every word the pyannote speaker active at its midpoint. A word outside every segment takes
 * the nearest segment within `maxGapSec`; otherwise the speaker of the closest word that has one.
 * `segments` should be pyannote's exclusive diarization (sorted by start).
 */
export function assignWordSpeakers(
  words: TimedWord[],
  segments: DiarSegment[],
  maxGapSec = 0.7,
): TimedWord[] {
  const segs = [...segments].sort((a, b) => a.start - b.start);
  const out = words.map((w) => {
    const mid = (w.start + w.end) / 2;
    let lo = 0;
    let hi = segs.length - 1;
    let at = -1; // last segment starting at or before mid
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (segs[m]!.start <= mid) {
        at = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    let speaker: string | null = null;
    for (let k = Math.max(0, at - 2); k <= Math.min(segs.length - 1, at + 1); k++) {
      const s = segs[k]!;
      if (s.start <= mid && mid <= s.end) speaker = s.speaker;
    }
    if (!speaker) {
      let best = maxGapSec;
      for (let k = Math.max(0, at - 2); k <= Math.min(segs.length - 1, at + 2); k++) {
        const s = segs[k]!;
        const gap = mid < s.start ? s.start - mid : mid - s.end;
        if (gap <= best) {
          best = gap;
          speaker = s.speaker;
        }
      }
    }
    return { ...w, speaker };
  });
  // Fill the rest from the nearest word that has a speaker.
  const known = out.map((w, i) => (w.speaker ? i : -1)).filter((i) => i >= 0);
  if (!known.length) return out;
  let p = 0;
  let q = 0; // first known word after i (moves forward only)
  return out.map((w, i) => {
    if (w.speaker) return w;
    while (p < known.length - 1 && known[p + 1]! < i) p++;
    while (q < known.length && known[q]! <= i) q++;
    const before = known[p]! < i ? known[p]! : undefined;
    const after = q < known.length ? known[q] : undefined;
    const pick =
      before === undefined
        ? after!
        : after === undefined
          ? before
          : i - before <= after - i
            ? before
            : after;
    return { ...w, speaker: out[pick]!.speaker };
  });
}

export interface WordClockOptions {
  /** Gemini words aligned per block (memory is block × window). */
  blockWords?: number;
  /** How far Gemini times may be off from the Deepgram clock. */
  slackSec?: number;
  /** A speaker run shorter than this many words inside a turn joins its neighbour. */
  minRunWords?: number;
  minRunSec?: number;
}

export interface WordClockStats {
  words: number;
  matched: number;
}

interface Tok {
  turn: number;
  k: number; // position inside the turn's native words
  folded: string;
  approx: number;
}

/** First index in `words` (sorted by start) whose start is ≥ t. */
function firstStartAtOrAfter(words: TimedWord[], t: number): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (words[m]!.start < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/**
 * M3: align Gemini's native-script words to Deepgram's words (tolerant sequence alignment in
 * blocks), carry each matched Deepgram word's time and pyannote speaker onto the Gemini word, let
 * unmatched words take their neighbours', and regroup into turns by speaker. Gemini's text is
 * unchanged; only its times and speakers are replaced.
 */
export function wordClockJoin(
  turns: Turn[],
  dgWords: TimedWord[],
  { blockWords = 700, slackSec = 75, minRunWords = 3, minRunSec = 0.8 }: WordClockOptions = {},
): JoinResult & { stats: WordClockStats } {
  const dg = [...dgWords].sort((a, b) => a.start - b.start);
  const dgFolded = dg.map((w) => foldWord(w.text));
  const perTurn = turns.map((t) => splitWords(t.textNative));
  const toks: Tok[] = [];
  perTurn.forEach((words, turn) => {
    const t = turns[turn]!;
    words.forEach((w, k) =>
      toks.push({
        turn,
        k,
        folded: foldWord(w),
        approx: t.start + ((k + 0.5) / words.length) * (t.end - t.start),
      }),
    );
  });

  // 1. align in blocks, moving forward through the Deepgram words
  const matchOf = new Array<number>(toks.length).fill(-1);
  let dgPos = 0;
  for (let b = 0; b < toks.length; b += blockWords) {
    const block = toks.slice(b, b + blockWords);
    const from = Math.max(
      firstStartAtOrAfter(dg, block[0]!.approx - slackSec),
      Math.max(0, dgPos - 15),
    );
    const to = firstStartAtOrAfter(dg, block[block.length - 1]!.approx + slackSec);
    if (to <= from || !dg.length) continue;
    const hits = alignTokens(
      block.map((x) => x.folded),
      dgFolded.slice(from, to),
    );
    let lastHit = -1;
    hits.forEach((j, i) => {
      if (j >= 0) {
        matchOf[b + i] = from + j;
        lastHit = from + j;
      }
    });
    if (lastHit >= 0) dgPos = lastHit + 1;
  }

  // 2. time and speaker per token; unmatched tokens interpolate / inherit
  const n = toks.length;
  const start = new Array<number>(n).fill(NaN);
  const end = new Array<number>(n).fill(NaN);
  const spk = new Array<string | null>(n).fill(null);
  matchOf.forEach((j, i) => {
    if (j < 0) return;
    start[i] = dg[j]!.start;
    end[i] = dg[j]!.end;
    spk[i] = dg[j]!.speaker ?? null;
  });
  const prevAnchor = new Array<number>(n).fill(-1);
  const nextAnchor = new Array<number>(n).fill(-1);
  for (let i = 0, last = -1; i < n; i++) {
    prevAnchor[i] = last;
    if (matchOf[i]! >= 0) last = i;
  }
  for (let i = n - 1, next = -1; i >= 0; i--) {
    nextAnchor[i] = next;
    if (matchOf[i]! >= 0) next = i;
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(start[i]!)) continue;
    const prev = prevAnchor[i]! >= 0 ? prevAnchor[i]! : undefined;
    const next = nextAnchor[i]! >= 0 ? nextAnchor[i]! : undefined;
    const t = turns[toks[i]!.turn]!;
    if (prev !== undefined && next !== undefined) {
      const f = (i - prev) / (next - prev);
      start[i] = end[prev]! + f * (start[next]! - end[prev]!);
      end[i] =
        start[i]! + Math.min(0.4, Math.max(0.05, (start[next]! - end[prev]!) / (next - prev)));
    } else {
      start[i] = toks[i]!.approx;
      end[i] = Math.min(t.end, toks[i]!.approx + 0.4);
    }
    const pick =
      prev === undefined ? next : next === undefined ? prev : i - prev <= next - i ? prev : next;
    spk[i] = pick === undefined ? null : spk[pick]!;
  }

  // 3. regroup per turn into speaker runs, absorbing tiny runs
  const out: Turn[] = [];
  const sourceIndex: number[] = [];
  const tokenSpeakers: string[][] = [];
  let at = 0;
  turns.forEach((t, idx) => {
    const words = perTurn[idx]!;
    if (!words.length) {
      out.push({ ...t, speaker: 'unknown' });
      sourceIndex.push(idx);
      tokenSpeakers.push([]);
      return;
    }
    const lo = at;
    at += words.length;
    const romanWords = splitWords(t.textRoman);
    interface WRun {
      speaker: string;
      from: number;
      to: number; // exclusive, token index
    }
    let runs: WRun[] = [];
    for (let i = lo; i < at; i++) {
      const s = spk[i] ?? 'unknown';
      const last = runs[runs.length - 1];
      if (last && last.speaker === s) last.to = i + 1;
      else runs.push({ speaker: s, from: i, to: i + 1 });
    }
    const size = (r: WRun): number => r.to - r.from;
    const secs = (r: WRun): number => end[r.to - 1]! - start[r.from]!;
    for (;;) {
      if (runs.length < 2) break;
      const small = runs.findIndex((r) => size(r) < minRunWords || secs(r) < minRunSec);
      if (small < 0) break;
      const left = runs[small - 1];
      const right = runs[small + 1];
      const into = (left ? size(left) : -1) >= (right ? size(right) : -1) ? small - 1 : small + 1;
      const target = runs[into]!;
      target.from = Math.min(target.from, runs[small]!.from);
      target.to = Math.max(target.to, runs[small]!.to);
      runs.splice(small, 1);
      const merged: WRun[] = [];
      for (const r of runs) {
        const last = merged[merged.length - 1];
        if (last && last.speaker === r.speaker) last.to = r.to;
        else merged.push({ ...r });
      }
      runs = merged;
    }
    const fractions = runs.map(size);
    const romanCuts = cutPoints(fractions, romanWords.length);
    let rPrev = 0;
    const speakers: string[] = [];
    runs.forEach((r, i) => {
      const ro = romanWords.slice(rPrev, romanCuts[i]);
      rPrev = romanCuts[i]!;
      for (let k = r.from; k < r.to; k++) speakers.push(r.speaker);
      const matched = matchOf.slice(r.from, r.to).filter((m) => m >= 0).length;
      const s0 = Math.min(...start.slice(r.from, r.to));
      const e0 = Math.max(...end.slice(r.from, r.to));
      out.push({
        speaker: r.speaker,
        start: s0,
        end: Math.max(e0, s0 + 0.2),
        textNative: words.slice(r.from - lo, r.to - lo).join(' '),
        textRoman: ro.join(' '),
        lang: t.lang,
        ...(matched * 2 < size(r) ? { timeEstimated: true } : {}),
        ...(t.romanFix ? { romanFix: t.romanFix } : {}),
      });
      sourceIndex.push(idx);
    });
    tokenSpeakers.push(speakers);
  });
  return {
    turns: out,
    tokenSpeakers,
    sourceIndex,
    stats: { words: n, matched: matchOf.filter((m) => m >= 0).length },
  };
}
