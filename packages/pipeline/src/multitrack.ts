// Multi-phone capture (prototype): align several phones' recordings of the same meeting, build a
// best-channel mix, and measure who was closest to which phone. Pure functions over mono PCM at 16 kHz.

export const MT_SAMPLE_RATE = 16000;
/** RMS envelope resolution: 10 ms frames over 8 kHz audio. */
export const ENVELOPE_HZ = 100;

const SAMPLES_PER_FRAME = MT_SAMPLE_RATE / ENVELOPE_HZ; // 160 samples at 16 kHz = 80 at 8 kHz

/** RMS per 10 ms frame, computed on audio decimated to 8 kHz (averaging sample pairs). */
export function rmsEnvelope(samples: Float32Array): Float32Array {
  const frames = Math.floor(samples.length / SAMPLES_PER_FRAME);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * SAMPLES_PER_FRAME;
    for (let i = 0; i < SAMPLES_PER_FRAME; i += 2) {
      const v = 0.5 * (samples[base + i]! + samples[base + i + 1]!);
      sum += v * v;
    }
    out[f] = Math.sqrt(sum / (SAMPLES_PER_FRAME / 2));
  }
  return out;
}

export interface LagEstimate {
  /** Frames by which `other` runs behind `ref`: other[t] ≈ ref[t − lag] (negative: ahead). */
  lag: number;
  /** Normalised correlation at that lag, −1..1. */
  score: number;
}

/**
 * Best delay of `other` against the window `ref[start, start+len)`: maximises the normalised
 * correlation of mean-removed envelopes over lags in [centre−maxLag, centre+maxLag] (frames), then
 * refines to a fraction of a frame with a parabola through the peak.
 */
export function estimateLag(
  ref: Float32Array,
  other: Float32Array,
  start: number,
  len: number,
  centre: number,
  maxLag: number,
  minOverlap = Math.max(50, Math.floor(len / 2)),
): LagEstimate | null {
  const end = Math.min(ref.length, start + len);
  if (end - start < 50) return null;
  const m = other.length;
  // prefix sums of both envelopes: mean and energy of any overlapping stretch in O(1)
  const px = new Float64Array(ref.length + 1);
  const pxx = new Float64Array(ref.length + 1);
  for (let i = 0; i < ref.length; i++) {
    px[i + 1] = px[i]! + ref[i]!;
    pxx[i + 1] = pxx[i]! + ref[i]! * ref[i]!;
  }
  const py = new Float64Array(m + 1);
  const pyy = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    py[i + 1] = py[i]! + other[i]!;
    pyy[i + 1] = pyy[i]! + other[i]! * other[i]!;
  }
  const lo = Math.round(centre - maxLag);
  const hi = Math.round(centre + maxLag);
  const scores = new Float64Array(hi - lo + 1).fill(-2);
  let best = -2;
  let bestIdx = -1;
  for (let d = lo; d <= hi; d++) {
    // ref[t] ≈ other[t + d]; only the stretch where both exist is compared
    const s0 = Math.max(start, -d);
    const e0 = Math.min(end, m - d);
    const n = e0 - s0;
    if (n < minOverlap) continue;
    const mx = (px[e0]! - px[s0]!) / n;
    const my = (py[e0 + d]! - py[s0 + d]!) / n;
    const vx = pxx[e0]! - pxx[s0]! - n * mx * mx;
    const vy = pyy[e0 + d]! - pyy[s0 + d]! - n * my * my;
    if (vx < 1e-9 || vy < 1e-9) continue;
    let dot = 0;
    for (let t = s0; t < e0; t++) dot += ref[t]! * other[t + d]!;
    const score = (dot - n * mx * my) / Math.sqrt(vx * vy);
    scores[d - lo] = score;
    if (score > best) {
      best = score;
      bestIdx = d - lo;
    }
  }
  if (bestIdx < 0) return null;
  let lag = lo + bestIdx;
  const left = scores[bestIdx - 1];
  const right = scores[bestIdx + 1];
  if (left !== undefined && right !== undefined && left > -2 && right > -2) {
    const denom = left - 2 * best + right;
    if (denom < 0) lag += Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denom));
  }
  return { lag, score: best };
}

export interface OffsetPoint {
  /** Seconds into the reference track at the middle of the window. */
  t: number;
  /** Seconds `other` runs behind the reference at that time. */
  offset: number;
  score: number;
}

export interface TrackAlignOptions {
  /** Where to look first: the coarse offset from the phones' server timestamps (seconds). */
  expectedOffsetSec?: number;
  /** Search ±this many seconds around the expectation. */
  searchSec?: number;
  windowSec?: number;
  /** Windows scoring below this are ignored. */
  minScore?: number;
}

/**
 * Offset of `other` against `ref` in every window (default 5 minutes). Each window searches around
 * the previous window's answer, so a drift of a few hundred ms per window is followed.
 */
export function offsetsPerWindow(
  ref: Float32Array,
  other: Float32Array,
  {
    expectedOffsetSec = 0,
    searchSec = 30,
    windowSec = 300,
    minScore = 0.35,
  }: TrackAlignOptions = {},
): OffsetPoint[] {
  const envRef = rmsEnvelope(ref);
  const envOther = rmsEnvelope(other);
  const win = windowSec * ENVELOPE_HZ;
  const points: OffsetPoint[] = [];
  let centre = expectedOffsetSec * ENVELOPE_HZ;
  let reach = searchSec * ENVELOPE_HZ;
  for (let start = 0; start < envRef.length; start += win) {
    const len = Math.min(win, envRef.length - start);
    if (len < 30 * ENVELOPE_HZ && points.length) break; // a short tail adds noise, not information
    const est = estimateLag(envRef, envOther, start, len, centre, reach);
    if (!est || est.score < minScore) continue;
    points.push({
      t: (start + len / 2) / ENVELOPE_HZ,
      offset: est.lag / ENVELOPE_HZ,
      score: est.score,
    });
    centre = est.lag;
    reach = Math.min(reach, 5 * ENVELOPE_HZ); // once locked, stay close
  }
  return points;
}

export interface DriftFit {
  /** Seconds the track runs behind the reference at t = 0. */
  a: number;
  /** Seconds of extra delay per second (0.001 = the phone's clock runs 0.1 % slow). */
  b: number;
  used: number;
}

/** Straight line offset(t) = a + b·t through the window offsets, ignoring outliers (median-based). */
export function fitDrift(points: OffsetPoint[]): DriftFit | null {
  let pts = points.filter((p) => Number.isFinite(p.offset));
  if (!pts.length) return null;
  const fit = (use: OffsetPoint[]): DriftFit => {
    if (use.length === 1) return { a: use[0]!.offset, b: 0, used: 1 };
    let sw = 0;
    let st = 0;
    let so = 0;
    for (const p of use) {
      sw += p.score;
      st += p.score * p.t;
      so += p.score * p.offset;
    }
    const mt = st / sw;
    const mo = so / sw;
    let num = 0;
    let den = 0;
    for (const p of use) {
      num += p.score * (p.t - mt) * (p.offset - mo);
      den += p.score * (p.t - mt) ** 2;
    }
    const b = den > 1e-9 ? num / den : 0;
    return { a: mo - b * mt, b, used: use.length };
  };
  let line = fit(pts);
  for (let round = 0; round < 2 && pts.length > 3; round++) {
    const res = pts.map((p) => Math.abs(p.offset - (line.a + line.b * p.t)));
    const med = [...res].sort((x, y) => x - y)[Math.floor(res.length / 2)]!;
    const keep = pts.filter((_, i) => res[i]! <= Math.max(0.05, 3 * med));
    if (keep.length === pts.length || keep.length < 2) break;
    pts = keep;
    line = fit(pts);
  }
  return line;
}

/**
 * Re-time a track: output sample t takes the input at t + (a + b·t) seconds (linear interpolation),
 * so a phone that started `a` s late and runs `b` slow lines up with the reference.
 */
export function alignTrack(
  samples: Float32Array,
  fitted: { a: number; b: number },
  outLength: number,
): Float32Array {
  const out = new Float32Array(outLength);
  for (let t = 0; t < outLength; t++) {
    const src = t + (fitted.a + fitted.b * (t / MT_SAMPLE_RATE)) * MT_SAMPLE_RATE;
    const i = Math.floor(src);
    if (i < 0 || i + 1 >= samples.length) continue;
    const f = src - i;
    out[t] = samples[i]! * (1 - f) + samples[i + 1]! * f;
  }
  return out;
}

export const LOUDNESS_HOP_SEC = 0.25;
/** Hops quieter than this on every phone are silence (before level matching). */
const SILENCE_DB = -55;

/** RMS of each 250 ms hop, in dB (−100 for silence). */
export function loudnessDb(samples: Float32Array, hopSec = LOUDNESS_HOP_SEC): Float32Array {
  const hop = Math.round(hopSec * MT_SAMPLE_RATE);
  const n = Math.floor(samples.length / hop);
  const out = new Float32Array(n);
  for (let h = 0; h < n; h++) {
    let sum = 0;
    for (let i = h * hop; i < (h + 1) * hop; i++) sum += samples[i]! * samples[i]!;
    out[h] = 20 * Math.log10(Math.max(1e-5, Math.sqrt(sum / hop)));
  }
  return out;
}

/** The level every track is brought to before comparing and mixing: typical speech at −20 dBFS. */
export const TARGET_LEVEL_DB = -20;

/** dB to add so that the track's typical speech level (upper quartile of its active hops) is −20 dB. */
export function levelOffsetDb(loudness: Float32Array): number {
  const active = [...loudness].filter((v) => v > -60).sort((a, b) => a - b);
  if (!active.length) return 0;
  // the median of the upper half: speech, not the noise floor between words
  return TARGET_LEVEL_DB - active[Math.floor(active.length * 0.75)]!;
}

export interface MixResult {
  mix: Float32Array;
  /** Index of the track used in each hop. */
  chosen: number[];
  /** Level-matched loudness per track per hop (dB). */
  loudness: Float32Array[];
  switches: number;
}

/**
 * Best-channel mix: tracks are level-matched, then for every 250 ms hop the loudest track is used
 * (the phone closest to whoever speaks); changes between tracks are cross-faded over 20 ms. It is
 * never a plain sum, which would add the room's echo and every phone's noise.
 */
export function bestChannelMix(
  tracks: Float32Array[],
  { hopSec = LOUDNESS_HOP_SEC, crossfadeMs = 20, switchMarginDb = 1.5 } = {},
): MixResult {
  const length = Math.max(0, ...tracks.map((t) => t.length));
  const hop = Math.round(hopSec * MT_SAMPLE_RATE);
  const raw = tracks.map((t) => loudnessDb(t, hopSec));
  const gains = raw.map((l) => levelOffsetDb(l));
  const loudness = raw.map((l, i) => l.map((v) => v + gains[i]!) as Float32Array);
  const hops = Math.ceil(length / hop);
  const chosen: number[] = [];
  let current = 0;
  for (let h = 0; h < hops; h++) {
    let best = current;
    let bestDb = loudness[current]?.[h] ?? -Infinity;
    // nobody is speaking near any phone: stay put (level-matched noise floors differ by chance)
    if (raw.every((r) => (r[h] ?? -100) < SILENCE_DB)) {
      chosen.push(current);
      continue;
    }
    loudness.forEach((l, i) => {
      const v = l[h] ?? -Infinity;
      // hysteresis: only switch for a clearly louder track, which stops flapping between phones
      if (v > bestDb + (i === current ? 0 : switchMarginDb)) {
        best = i;
        bestDb = v;
      }
    });
    current = best;
    chosen.push(current);
  }
  const lin = gains.map((g) => 10 ** (g / 20));
  const mix = new Float32Array(length);
  for (let h = 0; h < hops; h++) {
    const src = tracks[chosen[h]!]!;
    const g = lin[chosen[h]!]!;
    for (let i = h * hop; i < Math.min(length, (h + 1) * hop); i++) mix[i] = (src[i] ?? 0) * g;
  }
  const fade = Math.round((crossfadeMs / 1000) * MT_SAMPLE_RATE);
  let switches = 0;
  for (let h = 1; h < hops; h++) {
    if (chosen[h] === chosen[h - 1]) continue;
    switches++;
    const a = tracks[chosen[h - 1]!]!;
    const b = tracks[chosen[h]!]!;
    const ga = lin[chosen[h - 1]!]!;
    const gb = lin[chosen[h]!]!;
    const at = h * hop;
    for (let k = 0; k < fade; k++) {
      const i = at - fade / 2 + k;
      if (i < 0 || i >= length) continue;
      const w = (k + 0.5) / fade;
      mix[i] = (a[i] ?? 0) * ga * (1 - w) + (b[i] ?? 0) * gb * w;
    }
  }
  return { mix, chosen, loudness, switches };
}

export interface Attribution {
  /** Index of the track (phone) that was closest, or null when no phone clearly was. */
  track: number | null;
  /** Share of the segment's hops in which that phone was the loudest. */
  share: number;
  /** Mean lead over the next loudest phone in those hops (dB). */
  marginDb: number;
}

/**
 * Which phone was closest to the voice in each segment: the one loudest (level-matched) for most
 * hops of the segment, with a mean lead of at least `minMarginDb` over the runner-up. Otherwise it
 * abstains. A hint to show beside the voiceprint match, never an identity on its own.
 */
export function attributeSegments(
  loudness: Float32Array[],
  segments: { start: number; end: number }[],
  { hopSec = LOUDNESS_HOP_SEC, minMarginDb = 3, minShare = 0.5 } = {},
): Attribution[] {
  return segments.map((seg) => {
    const from = Math.floor(seg.start / hopSec);
    const to = Math.max(from + 1, Math.ceil(seg.end / hopSec));
    const wins = new Array<number>(loudness.length).fill(0);
    const lead = new Array<number>(loudness.length).fill(0);
    let hops = 0;
    for (let h = from; h < to; h++) {
      const vals = loudness.map((l) => l[h] ?? -Infinity);
      if (vals.every((v) => v < -60)) continue;
      const order = vals.map((v, i) => [v, i] as const).sort((x, y) => y[0] - x[0]);
      hops++;
      wins[order[0]![1]]!++;
      lead[order[0]![1]]! += order[0]![0] - (order[1]?.[0] ?? order[0]![0] - 10);
    }
    if (!hops) return { track: null, share: 0, marginDb: 0 };
    const top = wins.indexOf(Math.max(...wins));
    const share = wins[top]! / hops;
    const marginDb = lead[top]! / wins[top]!;
    return share > minShare && marginDb >= minMarginDb
      ? {
          track: top,
          share: Math.round(share * 100) / 100,
          marginDb: Math.round(marginDb * 10) / 10,
        }
      : {
          track: null,
          share: Math.round(share * 100) / 100,
          marginDb: Math.round(marginDb * 10) / 10,
        };
  });
}
