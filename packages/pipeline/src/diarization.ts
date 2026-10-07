import { quantile } from './silence.js';

/** One pyannote diarization segment (seconds, absolute in the meeting). */
export interface DiarSegment {
  speaker: string;
  start: number;
  end: number;
  /** Turn-level confidence per diarization speaker (0–100), when requested. */
  confidence?: Record<string, number>;
}

/** The parts of a pyannote diarize/identify output that Phase 2 reads. */
export interface DiarizationOutput {
  diarization: DiarSegment[];
  exclusiveDiarization?: DiarSegment[];
  identification?: (DiarSegment & { diarizationSpeaker: string; match: string | null })[];
  voiceprints?: { speaker: string; match: string | null; confidence: Record<string, number> }[];
  warning?: string;
}

export interface DiarizationStats {
  speakers: number;
  segments: number;
  /** Seconds where at least one speaker is active. */
  speechSec: number;
  /** Seconds where two or more speakers are active, as a share of speechSec. */
  overlapShare: number;
  medianSegSec: number | null;
  p90SegSec: number | null;
  /**
   * Share of speech seconds whose turn confidence for its own speaker is below `lowConfidence`
   * (pyannote caps turn confidence at 90, so a median says little); null without turn confidence.
   */
  lowConfidenceShare: number | null;
  /** Speech seconds per speaker, largest first. */
  perSpeaker: { speaker: string; sec: number }[];
}

const round = (n: number, d = 1): number => Math.round(n * 10 ** d) / 10 ** d;

/** Union length of the segments' time ranges. */
export function unionSeconds(segs: { start: number; end: number }[]): number {
  const sorted = [...segs].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const s of sorted) {
    if (s.start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s.start;
      curEnd = s.end;
    } else curEnd = Math.max(curEnd, s.end);
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

/** Seconds covered by two or more segments at once (sweep over start/end events). */
export function overlapSeconds(segs: { start: number; end: number }[]): number {
  const events: [number, number][] = [];
  for (const s of segs) {
    if (s.end <= s.start) continue;
    events.push([s.start, 1], [s.end, -1]);
  }
  // Ends before starts at the same instant, so touching segments do not count as overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let last = 0;
  let total = 0;
  for (const [t, d] of events) {
    if (active >= 2) total += t - last;
    active += d;
    last = t;
  }
  return total;
}

export function diarizationStats(segs: DiarSegment[], lowConfidence = 60): DiarizationStats {
  const lengths = segs.map((s) => s.end - s.start);
  const per = new Map<string, number>();
  for (const s of segs) per.set(s.speaker, (per.get(s.speaker) ?? 0) + (s.end - s.start));
  const speechSec = unionSeconds(segs);
  let confSec = 0;
  let lowSec = 0;
  for (const s of segs) {
    const c = s.confidence?.[s.speaker];
    if (typeof c !== 'number') continue;
    confSec += s.end - s.start;
    if (c < lowConfidence) lowSec += s.end - s.start;
  }
  const med = quantile(lengths, 0.5);
  const p90 = quantile(lengths, 0.9);
  return {
    speakers: per.size,
    segments: segs.length,
    speechSec: round(speechSec),
    overlapShare: speechSec > 0 ? round(overlapSeconds(segs) / speechSec, 3) : 0,
    medianSegSec: med === null ? null : round(med, 2),
    p90SegSec: p90 === null ? null : round(p90, 2),
    lowConfidenceShare: confSec > 0 ? round(lowSec / confSec, 3) : null,
    perSpeaker: [...per]
      .map(([speaker, sec]) => ({ speaker, sec: round(sec) }))
      .sort((a, b) => b.sec - a.sec),
  };
}

export function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** `[mm:ss–mm:ss] SPEAKER_xx` lines for the first `limit` segments starting before `untilSec`. */
export function sampleSegments(segs: DiarSegment[], untilSec = 120, limit = 12): string[] {
  return [...segs]
    .sort((a, b) => a.start - b.start)
    .filter((s) => s.start < untilSec)
    .slice(0, limit)
    .map((s) => `[${mmss(s.start)}–${mmss(s.end)}] ${s.speaker}`);
}
