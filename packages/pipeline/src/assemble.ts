import type { Turn } from '@meetingid/shared';
import { alignSeam, rescaleTurns, type SeamAlignment } from './align.js';
import { mergeChunkTurns } from './seam.js';
import { linkSpeakersAcrossChunks, type LinkOptions } from './speakerLink.js';

export interface ChunkTurns {
  startSec: number;
  endSec: number;
  /** Turns in absolute time, labelled with the engine's chunk-local speaker labels. */
  turns: Turn[];
}

export interface AssembleResult {
  /** Turns in time order with global labels `S1..Sn` (numbered by first appearance). */
  turns: Turn[];
  speakerCount: number;
  /** Clock correction applied at each seam, earlier chunk first. */
  seams: SeamAlignment[];
}

/**
 * Stitch per-chunk transcripts into one: correct each chunk's clock drift against the next chunk,
 * link each chunk's speaker labels to the previous chunk's
 * through their shared overlap, relabel, then merge at the seam. Chunks with no overlap (a failed
 * chunk left a gap) are appended with fresh labels.
 */
export function assembleChunks(chunks: ChunkTurns[], linkOptions?: LinkOptions): AssembleResult {
  const ordered = [...chunks].sort((a, b) => a.startSec - b.startSec).map((c) => ({ ...c }));
  // Correct each chunk's clock against the next chunk before linking and merging (see align.ts).
  const seams: SeamAlignment[] = [];
  for (let i = 0; i + 1 < ordered.length; i++) {
    const cur = ordered[i]!;
    const a = alignSeam(cur, ordered[i + 1]!);
    seams.push(a);
    cur.turns = rescaleTurns(cur.turns, cur.startSec, a.scale);
  }
  let next = 1;
  const fresh = (): string => `G${next++}`;

  let merged: Turn[] = [];
  let prevEnd = -Infinity;
  for (const chunk of ordered) {
    const overlap = { start: chunk.startSec, end: Math.min(prevEnd, chunk.endSec) };
    const prevInOverlap = merged.filter((t) => t.end >= overlap.start);
    const links =
      overlap.end > overlap.start
        ? linkSpeakersAcrossChunks(prevInOverlap, chunk.turns, overlap, linkOptions)
        : {};
    const labelMap = new Map<string, string>();
    for (const t of chunk.turns) {
      if (labelMap.has(t.speaker)) continue;
      labelMap.set(t.speaker, links[t.speaker] ?? fresh());
    }
    const relabelled = chunk.turns.map((t) => ({
      ...t,
      speaker: labelMap.get(t.speaker) ?? t.speaker,
    }));
    merged =
      overlap.end > overlap.start
        ? mergeChunkTurns(merged, relabelled, overlap)
        : [...merged, ...relabelled];
    prevEnd = Math.max(prevEnd, chunk.endSec);
  }

  // Renumber by first appearance so labels are stable and dense: S1, S2, …
  const final = new Map<string, string>();
  for (const t of merged) if (!final.has(t.speaker)) final.set(t.speaker, `S${final.size + 1}`);
  return {
    turns: merged.map((t) => ({ ...t, speaker: final.get(t.speaker) ?? t.speaker })),
    speakerCount: final.size,
    seams,
  };
}
