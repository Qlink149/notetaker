import type { Segment, Turn } from '@meetingid/shared';
import { unionIntervals } from './coverage.js';
import { linkSpeakersAcrossChunks } from './speakerLink.js';
import { jaccard } from './text.js';

export interface Gap extends Segment {
  /** Seconds of detected speech inside the gap. */
  speechSec: number;
}

/**
 * Stretches of detected speech that no transcript turn covers (turns widened by `padSec`, as in the
 * coverage metric), longest first. Uncovered pieces closer than `joinSec` are joined so a gap is
 * not split by a pause. Only gaps with at least `minSec` of speech are returned.
 */
export function findTranscriptGaps(
  speechSegments: Segment[],
  turns: Turn[],
  {
    minSec = 5,
    padSec = 1,
    joinSec = 2,
  }: { minSec?: number; padSec?: number; joinSec?: number } = {},
): Gap[] {
  const covered = unionIntervals(
    turns.map((t) => ({ start: t.start - padSec, end: Math.max(t.end, t.start) + padSec })),
  );
  const uncovered: Segment[] = [];
  for (const s of unionIntervals(speechSegments)) {
    let cursor = s.start;
    for (const c of covered) {
      if (c.end <= cursor || c.start >= s.end) continue;
      if (c.start > cursor) uncovered.push({ start: cursor, end: Math.min(c.start, s.end) });
      cursor = Math.max(cursor, c.end);
      if (cursor >= s.end) break;
    }
    if (cursor < s.end) uncovered.push({ start: cursor, end: s.end });
  }
  const joined: Gap[] = [];
  for (const u of uncovered) {
    const last = joined[joined.length - 1];
    if (last && u.start - last.end <= joinSec) {
      last.end = u.end;
      last.speechSec += u.end - u.start;
    } else joined.push({ start: u.start, end: u.end, speechSec: u.end - u.start });
  }
  const r = (n: number) => Math.round(n * 10) / 10;
  return joined
    .filter((g) => g.speechSec >= minSec)
    .map((g) => ({ start: r(g.start), end: r(g.end), speechSec: r(g.speechSec) }))
    .sort((a, b) => b.speechSec - a.speechSec);
}

/** "seam" when the gap touches a chunk overlap (± `marginSec`), else "mid-chunk". */
export function classifyGap(
  gap: Segment,
  chunks: { startSec: number; endSec: number }[],
  marginSec = 15,
): 'seam' | 'mid-chunk' {
  const sorted = [...chunks].sort((a, b) => a.startSec - b.startSec);
  for (let i = 1; i < sorted.length; i++) {
    const o = { start: sorted[i]!.startSec - marginSec, end: sorted[i - 1]!.endSec + marginSec };
    if (gap.end >= o.start && gap.start <= o.end) return 'seam';
  }
  return 'mid-chunk';
}

/**
 * Insert turns transcribed for a gap (absolute times, global labels): only turns whose midpoint lies
 * inside the gap (± `slackSec`) are kept, so the padding context is not duplicated, and any that
 * repeat an existing turn within ±8 s are dropped.
 */
export function mergeGapTurns(turns: Turn[], gapTurns: Turn[], gap: Segment, slackSec = 2): Turn[] {
  const inGap = gapTurns.filter((t) => {
    const mid = (t.start + t.end) / 2;
    return mid >= gap.start - slackSec && mid <= gap.end + slackSec;
  });
  const near = turns.filter((t) => t.end >= gap.start - 10 && t.start <= gap.end + 10);
  const fresh = inGap.filter(
    (g) =>
      !near.some(
        (t) =>
          Math.abs(t.start - g.start) <= 8 &&
          jaccard(t.textRoman || t.textNative, g.textRoman || g.textNative) >= 0.8,
      ),
  );
  return [...turns, ...fresh].sort((a, b) => a.start - b.start);
}

export interface GapFill extends Segment {
  cutStart: number;
  cutEnd: number;
  /** Turns from the gap call in absolute time, with the call's own (local) speaker labels. */
  turns: Turn[];
}

/**
 * Add gap-fill transcripts to an assembled transcript: each call's local speaker labels are linked
 * to the meeting's through the padding (both transcripts cover it), unmatched labels become new
 * speakers, only turns inside the gap are kept, and labels are renumbered S1..Sn by first
 * appearance.
 */
export function applyGapFills(turns: Turn[], fills: GapFill[]): Turn[] {
  let out = turns;
  let fresh = 0;
  for (const fill of fills) {
    const links = linkSpeakersAcrossChunks(out, fill.turns, {
      start: fill.cutStart,
      end: fill.cutEnd,
    });
    const labelMap = new Map<string, string>();
    for (const t of fill.turns) {
      if (!labelMap.has(t.speaker)) labelMap.set(t.speaker, links[t.speaker] ?? `F${++fresh}`);
    }
    const relabelled = fill.turns.map((t) => ({
      ...t,
      speaker: labelMap.get(t.speaker) ?? t.speaker,
    }));
    out = mergeGapTurns(out, relabelled, fill);
  }
  const final = new Map<string, string>();
  for (const t of out) if (!final.has(t.speaker)) final.set(t.speaker, `S${final.size + 1}`);
  return out.map((t) => ({ ...t, speaker: final.get(t.speaker) ?? t.speaker }));
}
