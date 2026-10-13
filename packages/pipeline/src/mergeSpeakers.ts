import type { DiarSegment, DiarizationOutput } from './diarization.js';

/**
 * pyannote sometimes splits one voice into two speakers (a quiet stretch, short answers, a change of
 * language or distance from the microphone). Each segment of its (non-exclusive) diarization carries a
 * confidence for every speaker label, so the split can be seen in its own numbers: for a split voice, the
 * segments of one label score the other label about as high as their own, in both directions, and the two
 * labels are never heard at the same moment. Two different people almost never satisfy both tests: their
 * segments score each other low, or they talk over each other.
 */
export interface MergeOptions {
  /** A label counts as "heard as" another where the other scores within this many points of its own. */
  gap?: number;
  /** Merge only when, in both directions, at least this share of the seconds is ambiguous. */
  minShare?: number;
  /**
   * The same test with a much tighter gap. Two different people who happen to sound alike pass the loose
   * test in one direction, but rarely score each other this close, so both tests are required.
   */
  tightGap?: number;
  minTightShare?: number;
  /** …and the two speak at the same moment for at most this share of the shorter one's time. */
  maxOverlapShare?: number;
  /** Labels with less speech than this are left alone: too little evidence either way. */
  minSeconds?: number;
}

export interface SpeakerMerge {
  /** The label that disappears, the label that keeps its speech and takes the other's. */
  from: string;
  into: string;
  /** Share of `from`'s seconds heard as `into`, and of `into`'s seconds heard as `from`. */
  ambiguity: [number, number];
  overlapShare: number;
}

const DEFAULTS: Required<MergeOptions> = {
  gap: 10,
  minShare: 0.7,
  tightGap: 5,
  minTightShare: 0.4,
  maxOverlapShare: 0.03,
  minSeconds: 5,
};

const dur = (s: { start: number; end: number }): number => s.end - s.start;

interface Stat {
  secs: Map<string, number>;
  /** amb.get(x)?.get(y): seconds of x heard as y. */
  amb: Map<string, Map<string, number>>;
  /** overlap seconds per unordered pair "x|y" (x < y). */
  overlap: Map<string, number>;
}

function measure(segs: DiarSegment[], rel: (l: string) => string, gap: number): Stat {
  const secs = new Map<string, number>();
  const amb = new Map<string, Map<string, number>>();
  const overlap = new Map<string, number>();
  const conf = segs.map((s) => {
    // a merged cluster scores as high as its best member
    const m = new Map<string, number>();
    for (const [label, v] of Object.entries(s.confidence ?? {})) {
      const c = rel(label);
      m.set(c, Math.max(m.get(c) ?? -Infinity, v));
    }
    return m;
  });
  segs.forEach((s, i) => {
    const x = rel(s.speaker);
    const d = dur(s);
    secs.set(x, (secs.get(x) ?? 0) + d);
    const own = conf[i]!.get(x);
    if (own === undefined) return;
    for (const [y, v] of conf[i]!) {
      if (y === x || v < own - gap) continue;
      const row = amb.get(x) ?? new Map<string, number>();
      amb.set(x, row);
      row.set(y, (row.get(y) ?? 0) + d);
    }
  });
  // overlap: segments are sorted by start, so only look ahead while they can still overlap
  const order = segs.map((_, i) => i).sort((a, b) => segs[a]!.start - segs[b]!.start);
  for (let a = 0; a < order.length; a++) {
    const sa = segs[order[a]!]!;
    for (let b = a + 1; b < order.length; b++) {
      const sb = segs[order[b]!]!;
      if (sb.start >= sa.end) break;
      const x = rel(sa.speaker);
      const y = rel(sb.speaker);
      if (x === y) continue;
      const o = Math.min(sa.end, sb.end) - sb.start;
      if (o <= 0) continue;
      const key = x < y ? `${x}|${y}` : `${y}|${x}`;
      overlap.set(key, (overlap.get(key) ?? 0) + o);
    }
  }
  return { secs, amb, overlap };
}

/**
 * Merge speaker labels that are one voice split in two (see the note above). Works on the diarization
 * that carries per-label confidence; the exclusive diarization is relabelled the same way. Greedy: the
 * most clearly split pair first, then everything is measured again with the merged label, until no pair
 * qualifies. The input is not changed.
 */
export function mergeConfusableSpeakers(
  output: DiarizationOutput,
  options: MergeOptions = {},
): { output: DiarizationOutput; merges: SpeakerMerge[] } {
  const o = { ...DEFAULTS, ...options };
  const segs = output.diarization;
  const withConf = segs.filter((s) => s.confidence && Object.keys(s.confidence).length > 1);
  const total = segs.reduce((n, s) => n + dur(s), 0);
  if (!total || withConf.reduce((n, s) => n + dur(s), 0) < total * 0.5)
    return { output, merges: [] };

  const parent = new Map<string, string>();
  const rel = (l: string): string => {
    let c = l;
    while (parent.has(c)) c = parent.get(c)!;
    return c;
  };
  const merges: SpeakerMerge[] = [];
  for (let round = 0; round < 50; round++) {
    const st = measure(segs, rel, o.gap);
    const tight = measure(segs, rel, o.tightGap);
    let best: { x: string; y: string; score: number; a: number; b: number; ov: number } | null = null;
    const labels = [...st.secs.keys()];
    for (const x of labels)
      for (const y of labels) {
        if (x >= y) continue;
        const sx = st.secs.get(x)!;
        const sy = st.secs.get(y)!;
        if (sx < o.minSeconds || sy < o.minSeconds) continue;
        const a = (st.amb.get(x)?.get(y) ?? 0) / sx;
        const b = (st.amb.get(y)?.get(x) ?? 0) / sy;
        const ov = (st.overlap.get(`${x}|${y}`) ?? 0) / Math.min(sx, sy);
        const a2 = (tight.amb.get(x)?.get(y) ?? 0) / sx;
        const b2 = (tight.amb.get(y)?.get(x) ?? 0) / sy;
        if (a < o.minShare || b < o.minShare || a2 < o.minTightShare || b2 < o.minTightShare) continue;
        if (ov > o.maxOverlapShare) continue;
        const score = Math.min(a, b);
        if (!best || score > best.score) best = { x, y, score, a, b, ov };
      }
    if (!best) break;
    const big = st.secs.get(best.x)! >= st.secs.get(best.y)! ? best.x : best.y;
    const small = big === best.x ? best.y : best.x;
    parent.set(small, big);
    const r2 = (n: number): number => Math.round(n * 100) / 100;
    merges.push({
      from: small,
      into: big,
      ambiguity: small === best.x ? [r2(best.a), r2(best.b)] : [r2(best.b), r2(best.a)],
      overlapShare: r2(best.ov),
    });
  }
  if (!merges.length) return { output, merges };

  return { output: relabelOutput(output, rel), merges };
}

function relabelOutput(output: DiarizationOutput, rel: (label: string) => string): DiarizationOutput {
  const relabel = (s: DiarSegment): DiarSegment => {
    const speaker = rel(s.speaker);
    if (!s.confidence) return speaker === s.speaker ? s : { ...s, speaker };
    const confidence: Record<string, number> = {};
    for (const [label, v] of Object.entries(s.confidence)) {
      const c = rel(label);
      confidence[c] = Math.max(confidence[c] ?? -Infinity, v);
    }
    return { ...s, speaker, confidence };
  };
  return {
    ...output,
    diarization: output.diarization.map(relabel),
    ...(output.exclusiveDiarization
      ? { exclusiveDiarization: output.exclusiveDiarization.map(relabel) }
      : {}),
  };
}

/**
 * Apply merges decided earlier (stored with the meeting) to a diarization reply, so that every later step
 * sees the same speakers as the transcript and cards did, without measuring again.
 */
export function applySpeakerMerges(
  output: DiarizationOutput,
  merges: Pick<SpeakerMerge, 'from' | 'into'>[],
): DiarizationOutput {
  if (!merges.length) return output;
  const parent = new Map(merges.map((m) => [m.from, m.into]));
  const rel = (l: string): string => {
    let c = l;
    for (let i = 0; i < 50 && parent.has(c); i++) c = parent.get(c)!;
    return c;
  };
  return relabelOutput(output, rel);
}
