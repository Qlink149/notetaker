import type { Coverage, Segment, Turn } from '@meetingid/shared';

/** Sort and merge overlapping or touching intervals. */
export function unionIntervals(segments: Segment[]): Segment[] {
  const sorted = segments
    .filter((s) => s.end > s.start)
    .map((s) => ({ start: s.start, end: s.end }))
    .sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push(s);
  }
  return out;
}

const total = (segments: Segment[]): number =>
  segments.reduce((sum, s) => sum + (s.end - s.start), 0);

/** Total length of the intersection of two interval unions. */
function intersectionLength(a: Segment[], b: Segment[]): number {
  let i = 0;
  let j = 0;
  let sum = 0;
  while (i < a.length && j < b.length) {
    const x = a[i]!;
    const y = b[j]!;
    const lo = Math.max(x.start, y.start);
    const hi = Math.min(x.end, y.end);
    if (hi > lo) sum += hi - lo;
    if (x.end < y.end) i++;
    else j++;
  }
  return sum;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * How much of the detected speech is covered by transcript turns (each widened by `padSec` to
 * tolerate timestamp drift). A ratio well below 1 means the engine skipped speech.
 */
export function computeCoverage(speechSegments: Segment[], turns: Turn[], padSec = 1): Coverage {
  const speech = unionIntervals(speechSegments);
  const covered = unionIntervals(
    turns.map((t) => ({ start: t.start - padSec, end: Math.max(t.end, t.start) + padSec })),
  );
  const speechSec = total(speech);
  const coveredSec = intersectionLength(speech, covered);
  return {
    speechSec: round2(speechSec),
    coveredSec: round2(coveredSec),
    ratio: speechSec > 0 ? Math.round((coveredSec / speechSec) * 1000) / 1000 : 0,
  };
}

/**
 * The complement of the silences reported by ffmpeg `silencedetect`, within [0, durationSec].
 * Speech runs shorter than `minSpeechSec` (clicks, coughs) are discarded.
 */
export function speechFromSilences(
  silences: Segment[],
  durationSec: number,
  minSpeechSec = 0.2,
): Segment[] {
  const quiet = unionIntervals(
    silences.map((s) => ({ start: Math.max(0, s.start), end: Math.min(durationSec, s.end) })),
  );
  const out: Segment[] = [];
  let cursor = 0;
  for (const s of quiet) {
    if (s.start - cursor >= minSpeechSec) out.push({ start: round2(cursor), end: round2(s.start) });
    cursor = Math.max(cursor, s.end);
  }
  if (durationSec - cursor >= minSpeechSec)
    out.push({ start: round2(cursor), end: round2(durationSec) });
  return out;
}
