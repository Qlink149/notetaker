import type { Turn } from '@meetingid/shared';
import type { Overlap } from './seam.js';
import { containment } from './text.js';

export interface LinkOptions {
  /** Minimum text similarity for two overlap turns to be treated as the same utterance. */
  minSimilarity?: number;
  /** Maximum start-time distance (seconds) between matched turns. Covers engine drift (10.5 s seen live). */
  windowSec?: number;
  /** The winning earlier label must outweigh the runner-up by this factor. */
  margin?: number;
}

/** Map from later-chunk label to the earlier label it continues, or `null` when unmatched. */
export type LabelMap = Record<string, string | null>;

const textOf = (t: Turn): string => t.textRoman || t.textNative;
const dur = (t: Turn): number => Math.max(0.5, t.end - t.start);
const inOverlap = (t: Turn, o: Overlap): boolean => t.end >= o.start && t.start <= o.end;

/**
 * Link anonymous speaker labels of a later chunk to those of the earlier chunk using the shared
 * overlap: both chunks transcribed the same speech there, so text-matched turns vote for a label
 * pairing, weighted by duration. Pairs are assigned greedily one-to-one, and only when the winner
 * beats the runner-up by `margin`. Later labels that never appear in the overlap, or have no
 * confident match, map to `null` (the caller gives them new labels).
 */
export function linkSpeakersAcrossChunks(
  prevTurns: Turn[],
  nextTurns: Turn[],
  overlap: Overlap,
  { minSimilarity = 0.6, windowSec = 15, margin = 1.5 }: LinkOptions = {},
): LabelMap {
  const result: LabelMap = {};
  for (const t of nextTurns) result[t.speaker] = null;
  if (overlap.end <= overlap.start) return result;

  const prevO = prevTurns.filter((t) => inOverlap(t, overlap));
  const nextO = nextTurns.filter((t) => inOverlap(t, overlap));

  // votes[later][earlier] = matched duration
  const votes = new Map<string, Map<string, number>>();
  for (const n of nextO) {
    let best: Turn | null = null;
    let bestSim = minSimilarity;
    for (const p of prevO) {
      if (Math.abs(p.start - n.start) > windowSec) continue;
      const sim = containment(textOf(p), textOf(n));
      if (sim >= bestSim) {
        best = p;
        bestSim = sim;
      }
    }
    if (!best) continue;
    const row = votes.get(n.speaker) ?? new Map<string, number>();
    row.set(best.speaker, (row.get(best.speaker) ?? 0) + Math.min(dur(n), dur(best)));
    votes.set(n.speaker, row);
  }

  const pairs: { later: string; earlier: string; weight: number }[] = [];
  for (const [later, row] of votes) {
    for (const [earlier, weight] of row) pairs.push({ later, earlier, weight });
  }
  pairs.sort((a, b) => b.weight - a.weight);

  const usedEarlier = new Set<string>();
  const assigned = new Set<string>();
  for (const { later, earlier, weight } of pairs) {
    if (assigned.has(later) || usedEarlier.has(earlier)) continue;
    const row = votes.get(later);
    let runnerUp = 0;
    for (const [e, w] of row ?? []) {
      if (e !== earlier && !usedEarlier.has(e)) runnerUp = Math.max(runnerUp, w);
    }
    if (weight < margin * runnerUp) continue;
    result[later] = earlier;
    assigned.add(later);
    usedEarlier.add(earlier);
  }
  return result;
}
