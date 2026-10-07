import type { DiarSegment } from './diarization.js';

export interface TimeRange {
  start: number;
  end: number;
}

/** Time ranges where two or more speakers are active (from the non-exclusive diarization). */
export function overlapRanges(segs: TimeRange[]): TimeRange[] {
  const events: [number, number][] = [];
  for (const s of segs) if (s.end > s.start) events.push([s.start, 1], [s.end, -1]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: TimeRange[] = [];
  let active = 0;
  let from = 0;
  for (const [t, d] of events) {
    if (active >= 2 && d === -1 && active - 1 < 2) out.push({ start: from, end: t });
    if (active < 2 && active + d >= 2) from = t;
    active += d;
  }
  return out;
}

export interface VoiceClip {
  speaker: string;
  start: number;
  end: number;
  /** Mean turn confidence (0–100) of the speaker's own segments in the clip; null if unknown. */
  quality: number | null;
}

export interface ClipOptions {
  speaker: string;
  /** Exclusive diarization (one speaker at a time). */
  exclusive: DiarSegment[];
  /** Time where more than one speaker talks; clips must stay clear of it. */
  overlaps: TimeRange[];
  meetingSec: number;
  maxClips?: number;
  /** Clips shorter than this are rejected. */
  minSec?: number;
  /** pyannote accepts at most 30 s. */
  maxSec?: number;
  /** Preferred length when a run is longer. */
  targetSec?: number;
  /** Segments of one speaker closer than this belong to the same stretch of talk. */
  joinGapSec?: number;
  /** Margin kept between a clip and any overlapped speech. */
  overlapMarginSec?: number;
}

interface Run {
  start: number;
  end: number;
  weighted: number;
  weight: number;
}

/**
 * Pick up to `maxClips` clips of one speaker for voiceprints: stretches where only this person
 * talks (no other speaker in between, no overlapped speech), 6–30 s long, the middle of a long
 * stretch preferred, best turn confidence first, spread across the thirds of the meeting.
 */
export function selectClips(o: ClipOptions): VoiceClip[] {
  const {
    speaker,
    maxClips = 3,
    minSec = 6,
    maxSec = 30,
    targetSec = 25,
    joinGapSec = 0.6,
    overlapMarginSec = 0.3,
  } = o;
  const segs = [...o.exclusive].sort((a, b) => a.start - b.start);

  // Stretches of this speaker: consecutive exclusive segments, nobody else between.
  const runs: Run[] = [];
  let cur: Run | null = null;
  let prevEnd = -Infinity;
  for (const s of segs) {
    if (s.speaker !== speaker) {
      cur = null;
      prevEnd = s.end;
      continue;
    }
    const dur = s.end - s.start;
    const conf = s.confidence?.[speaker];
    if (cur && s.start - prevEnd <= joinGapSec) {
      cur.end = s.end;
    } else {
      cur = { start: s.start, end: s.end, weighted: 0, weight: 0 };
      runs.push(cur);
    }
    if (typeof conf === 'number') {
      cur.weighted += conf * dur;
      cur.weight += dur;
    }
    prevEnd = s.end;
  }

  const clear = (a: number, b: number): boolean =>
    !o.overlaps.some((r) => r.end > a - overlapMarginSec && r.start < b + overlapMarginSec);

  const candidates: (VoiceClip & { score: number })[] = [];
  for (const r of runs) {
    const len = r.end - r.start;
    if (len < minSec) continue;
    const want = Math.min(len, maxSec, Math.max(minSec, targetSec));
    // Middle of the stretch; if that touches overlapped speech, slide to a clear window.
    const mid = (r.start + r.end) / 2;
    let start = mid - want / 2;
    if (!clear(start, start + want)) {
      start = NaN;
      for (let t = r.start; t + minSec <= r.end; t += 1) {
        const end = Math.min(r.end, t + want);
        if (end - t >= minSec && clear(t, end)) {
          start = t;
          break;
        }
      }
      if (Number.isNaN(start)) continue;
    }
    const end = Math.min(r.end, start + want);
    const quality = r.weight > 0 ? Math.round((r.weighted / r.weight) * 10) / 10 : null;
    candidates.push({
      speaker,
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      quality,
      score: (quality ?? 50) + Math.min(10, (end - start) / 3),
    });
  }
  candidates.sort((a, b) => b.score - a.score);

  const chosen: typeof candidates = [];
  const farFromChosen = (c: VoiceClip): boolean =>
    chosen.every((x) => Math.abs((x.start + x.end) / 2 - (c.start + c.end) / 2) >= 60);
  // First the best of each third of the meeting, then the best of what is left.
  for (let third = 0; third < 3 && chosen.length < maxClips; third++) {
    const lo = (o.meetingSec * third) / 3;
    const hi = (o.meetingSec * (third + 1)) / 3;
    const best = candidates.find((c) => (c.start + c.end) / 2 >= lo && (c.start + c.end) / 2 < hi);
    if (best) chosen.push(best);
  }
  for (const c of candidates) {
    if (chosen.length >= maxClips) break;
    if (!chosen.includes(c) && farFromChosen(c)) chosen.push(c);
  }
  return chosen
    .sort((a, b) => a.start - b.start)
    .map(({ speaker: sp, start, end, quality }) => ({ speaker: sp, start, end, quality }));
}
