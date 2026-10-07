import type { Turn } from '@meetingid/shared';
import { jaccard } from './text.js';

export interface Overlap {
  start: number;
  end: number;
}

export interface SeamOptions {
  /** Later-chunk turns at least this similar to a kept turn nearby are duplicates. */
  dedupeSimilarity?: number;
  /** How far apart (seconds) two turns may start and still count as the same utterance. */
  dedupeWindowSec?: number;
  /** Where to switch from the earlier to the later chunk; default the overlap midpoint. */
  cutAt?: number;
}

const textOf = (t: Turn): string => t.textRoman || t.textNative;

/**
 * Merge the turns of two adjacent chunks that share `overlap` (absolute seconds).
 * Earlier-chunk turns are kept up to the overlap midpoint and later-chunk turns from it on.
 * A later-chunk turn that repeats a kept earlier-chunk turn within ±8 s is dropped, which
 * absorbs the ~5 s timestamp drift engines show near the end of a chunk.
 * `next` must already carry linked (global) speaker labels.
 */
export function mergeChunkTurns(
  prev: Turn[],
  next: Turn[],
  overlap: Overlap,
  { dedupeSimilarity = 0.8, dedupeWindowSec = 8, cutAt }: SeamOptions = {},
): Turn[] {
  if (overlap.end <= overlap.start) {
    return [...prev, ...next].sort((a, b) => a.start - b.start);
  }
  const mid = cutAt ?? (overlap.start + overlap.end) / 2;
  const keptPrev = prev.filter((t) => t.start < mid);
  const nearSeam = keptPrev.filter((t) => t.end >= overlap.start - dedupeWindowSec);

  const keptNext = next.filter((t) => {
    if (t.start < mid) return false;
    return !nearSeam.some(
      (p) =>
        Math.abs(p.start - t.start) <= dedupeWindowSec &&
        jaccard(textOf(p), textOf(t)) >= dedupeSimilarity,
    );
  });

  return [...keptPrev, ...keptNext].sort((a, b) => a.start - b.start);
}
