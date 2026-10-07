import type { Turn } from '@meetingid/shared';
import type { DiarSegment } from '../diarization.js';
import { splitWords } from './tokens.js';
import { UNKNOWN_SPEAKER, cutPoints, type JoinResult } from './types.js';

export interface OverlapOptions {
  /** A speaker change inside a turn counts only if both sides last at least this long. */
  minSplitSec?: number;
  /** A turn with no overlapping segment takes the nearest segment within this distance. */
  nearestSec?: number;
}

interface Run {
  speaker: string;
  start: number;
  end: number;
}

/** pyannote segments clipped to [start, end], merged per speaker, with short runs absorbed. */
function runsInside(
  segs: DiarSegment[],
  start: number,
  end: number,
  minSplitSec: number,
  nearestSec: number,
): Run[] {
  let runs: Run[] = [];
  for (const s of segs) {
    if (s.end <= start) continue;
    if (s.start >= end) break;
    runs.push({ speaker: s.speaker, start: Math.max(s.start, start), end: Math.min(s.end, end) });
  }
  if (!runs.length) {
    let best: DiarSegment | null = null;
    let bestGap = nearestSec;
    for (const s of segs) {
      const gap = s.end <= start ? start - s.end : s.start >= end ? s.start - end : 0;
      if (gap <= bestGap) {
        best = s;
        bestGap = gap;
      }
    }
    return [{ speaker: best?.speaker ?? UNKNOWN_SPEAKER, start, end }];
  }
  const mergeSame = (): void => {
    const merged: Run[] = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && last.speaker === r.speaker) last.end = Math.max(last.end, r.end);
      else merged.push({ ...r });
    }
    runs = merged;
  };
  mergeSame();
  for (;;) {
    if (runs.length < 2) break;
    let shortest = -1;
    for (let i = 0; i < runs.length; i++) {
      const d = runs[i]!.end - runs[i]!.start;
      if (d < minSplitSec && (shortest < 0 || d < runs[shortest]!.end - runs[shortest]!.start))
        shortest = i;
    }
    if (shortest < 0) break;
    const left = runs[shortest - 1];
    const right = runs[shortest + 1];
    const dur = (r?: Run): number => (r ? r.end - r.start : -1);
    const into = dur(left) >= dur(right) ? shortest - 1 : shortest + 1;
    const target = runs[into]!;
    target.start = Math.min(target.start, runs[shortest]!.start);
    target.end = Math.max(target.end, runs[shortest]!.end);
    runs.splice(shortest, 1);
    mergeSame();
  }
  return runs;
}

/**
 * M1: give each Gemini turn the pyannote speaker with the most overlapping speech, using the
 * turn's (already corrected) times. A turn is split where pyannote changes speaker, but only if
 * both sides last at least `minSplitSec`; text is divided by each side's share of the time.
 * `segments` should be pyannote's exclusive diarization.
 */
export function assignByOverlap(
  turns: Turn[],
  segments: DiarSegment[],
  { minSplitSec = 1.5, nearestSec = 2 }: OverlapOptions = {},
): JoinResult {
  const segs = [...segments].sort((a, b) => a.start - b.start);
  const out: Turn[] = [];
  const sourceIndex: number[] = [];
  const tokenSpeakers: string[][] = [];
  turns.forEach((t, idx) => {
    const nativeWords = splitWords(t.textNative);
    const romanWords = splitWords(t.textRoman);
    const runs = runsInside(
      segs,
      t.start,
      Math.max(t.end, t.start + 0.01),
      minSplitSec,
      nearestSec,
    );
    if (runs.length === 1) {
      out.push({ ...t, speaker: runs[0]!.speaker });
      sourceIndex.push(idx);
      tokenSpeakers.push(nativeWords.map(() => runs[0]!.speaker));
      return;
    }
    const fractions = runs.map((r) => r.end - r.start);
    const nativeCuts = cutPoints(fractions, nativeWords.length);
    const romanCuts = cutPoints(fractions, romanWords.length);
    const speakers: string[] = [];
    let nPrev = 0;
    let rPrev = 0;
    runs.forEach((r, i) => {
      const n = nativeWords.slice(nPrev, nativeCuts[i]);
      const ro = romanWords.slice(rPrev, romanCuts[i]);
      nPrev = nativeCuts[i]!;
      rPrev = romanCuts[i]!;
      for (const _ of n) speakers.push(r.speaker);
      if (!n.length && !ro.length) return;
      const start = i === 0 ? t.start : (runs[i - 1]!.end + r.start) / 2;
      const end = i === runs.length - 1 ? t.end : (r.end + runs[i + 1]!.start) / 2;
      out.push({
        ...t,
        speaker: r.speaker,
        start,
        end: Math.max(end, start + 0.01),
        textNative: n.join(' '),
        textRoman: ro.join(' '),
        timeEstimated: true,
      });
      sourceIndex.push(idx);
    });
    tokenSpeakers.push(speakers);
  });
  return { turns: out, tokenSpeakers, sourceIndex };
}
