import type { Turn } from '@meetingid/shared';
import { containment, tokenize } from './text.js';

export interface AlignOptions {
  /** How far apart (seconds) the two transcriptions of one sentence may be. */
  searchSec?: number;
  /** Minimum share of the shorter sentence's words found in the other. */
  minSimilarity?: number;
  /** Sentences shorter than this cannot anchor (fillers repeat everywhere). */
  minTokens?: number;
  /** Corrections outside [1 - maxStretch, 1 + maxStretch] are ignored as implausible. */
  maxStretch?: number;
}

export interface SeamAlignment {
  /** Seconds to add to the earlier chunk's timeline at the seam (later minus earlier), or 0. */
  driftSec: number;
  /** Factor for the earlier chunk's timeline, fixed at its own start (1 = no change). */
  scale: number;
  anchors: number;
}

const textOf = (t: Turn): string => t.textRoman || t.textNative;

/**
 * Estimate how far the earlier chunk's clock has drifted by the seam, from sentences both chunks
 * transcribed (the 30 s overlap is the same audio). Measured live on gemini-3.5-flash: up to 26 s
 * at the end of a 10-minute chunk. Returns the median drift over all anchors and the linear factor
 * that maps the earlier chunk's timeline onto the later chunk's at the seam.
 */
export function alignSeam(
  prev: { startSec: number; endSec: number; turns: Turn[] },
  next: { startSec: number; endSec: number; turns: Turn[] },
  { searchSec = 60, minSimilarity = 0.7, minTokens = 5, maxStretch = 0.15 }: AlignOptions = {},
): SeamAlignment {
  const overlapStart = next.startSec;
  const overlapEnd = prev.endSec;
  if (overlapEnd <= overlapStart) return { driftSec: 0, scale: 1, anchors: 0 };
  const prevTail = prev.turns.filter(
    (t) => t.start >= overlapStart - searchSec && tokenize(textOf(t)).length >= minTokens,
  );
  const nextHead = next.turns.filter(
    (t) => t.start <= overlapEnd + searchSec && tokenize(textOf(t)).length >= minTokens,
  );

  const drifts: { drift: number; at: number }[] = [];
  for (const n of nextHead) {
    let best: { sim: number; p: Turn } | null = null;
    for (const p of prevTail) {
      if (Math.abs(p.start - n.start) > searchSec) continue;
      const sim = containment(textOf(p), textOf(n), minTokens);
      if (sim >= minSimilarity && (!best || sim > best.sim)) best = { sim, p };
    }
    if (best) drifts.push({ drift: n.start - best.p.start, at: best.p.start });
  }
  if (!drifts.length) return { driftSec: 0, scale: 1, anchors: 0 };

  drifts.sort((a, b) => a.drift - b.drift);
  const mid = drifts[Math.floor(drifts.length / 2)]!;
  const span = mid.at - prev.startSec;
  const scale = span > 0 ? (span + mid.drift) / span : 1;
  if (!Number.isFinite(scale) || Math.abs(scale - 1) > maxStretch)
    return { driftSec: 0, scale: 1, anchors: drifts.length };
  return { driftSec: Math.round(mid.drift * 10) / 10, scale, anchors: drifts.length };
}

/** Rescale a chunk's turns around its start (`t' = start + (t - start) * scale`). */
export function rescaleTurns(turns: Turn[], startSec: number, scale: number): Turn[] {
  if (scale === 1) return turns;
  const f = (t: number): number => Math.round((startSec + (t - startSec) * scale) * 1000) / 1000;
  return turns.map((t) => ({ ...t, start: f(t.start), end: f(t.end), timeScaled: true }));
}
