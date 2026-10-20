import type { DiarSegment } from './diarization.js';

/** Overlap needed, as a share of each side's speech in the earlier audio, before a decision is carried over. */
export const CARRY_MIN_SHARE = 0.5;
/** And at least this many seconds of it. */
export const CARRY_MIN_SEC = 3;

const speechBefore = (segments: DiarSegment[], endSec: number): Map<string, number> => {
  const t = new Map<string, number>();
  for (const s of segments) {
    const d = Math.min(s.end, endSec) - s.start;
    if (d > 0) t.set(s.speaker, (t.get(s.speaker) ?? 0) + d);
  }
  return t;
};

/**
 * When audio is added to a meeting, pyannote runs again on the longer recording and names its voices afresh
 * (SPEAKER_00 may now be someone else). Each voice a person decided in the earlier audio is matched to the
 * new voice that spoke at the same times in that audio: the pair must share more than half of each one's
 * speech there (and `CARRY_MIN_SEC`), one to one, largest overlap first. Voices with no clear match are
 * left out, so they are identified again instead of inheriting a wrong name.
 *
 * Returns old voice → new voice.
 */
export function carrySpeakers(
  oldSegments: DiarSegment[],
  newSegments: DiarSegment[],
  endSec: number,
  decided: string[],
): Map<string, string> {
  const oldSec = speechBefore(oldSegments, endSec);
  const newSec = speechBefore(newSegments, endSec);
  const overlap = new Map<string, number>();
  const want = new Set(decided);
  // both lists are short (a few hundred segments); sorted sweep is not worth it
  for (const a of oldSegments) {
    if (!want.has(a.speaker) || a.start >= endSec) continue;
    for (const b of newSegments) {
      const d = Math.min(a.end, b.end, endSec) - Math.max(a.start, b.start);
      if (d <= 0) continue;
      const k = `${a.speaker}\n${b.speaker}`;
      overlap.set(k, (overlap.get(k) ?? 0) + d);
    }
  }
  const pairs = [...overlap]
    .map(([k, sec]) => {
      const [from, to] = k.split('\n') as [string, string];
      return { from, to, sec };
    })
    .filter(
      (p) =>
        p.sec >= CARRY_MIN_SEC &&
        p.sec > CARRY_MIN_SHARE * (oldSec.get(p.from) ?? Infinity) &&
        p.sec > CARRY_MIN_SHARE * (newSec.get(p.to) ?? Infinity),
    )
    .sort((a, b) => b.sec - a.sec);
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const p of pairs) {
    if (out.has(p.from) || taken.has(p.to)) continue;
    out.set(p.from, p.to);
    taken.add(p.to);
  }
  return out;
}
