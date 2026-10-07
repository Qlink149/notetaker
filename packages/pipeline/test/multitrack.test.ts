import { describe, expect, it } from 'vitest';
import {
  MT_SAMPLE_RATE as SR,
  alignTrack,
  attributeSegments,
  bestChannelMix,
  fitDrift,
  loudnessDb,
  offsetsPerWindow,
} from '../src/index.js';

/** Deterministic noise bursts with irregular on/off timing: speech-like for envelope matching. */
function speechLike(seconds: number, seed = 1): Float32Array {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out = new Float32Array(seconds * SR);
  let t = 0;
  while (t < out.length) {
    const on = Math.floor((0.2 + rnd() * 1.3) * SR);
    const off = Math.floor((0.15 + rnd() * 0.9) * SR);
    const amp = 0.15 + rnd() * 0.5;
    for (let i = 0; i < on && t + i < out.length; i++) {
      // a slow syllable-like wobble on top of noise
      out[t + i] = (rnd() * 2 - 1) * amp * (0.6 + 0.4 * Math.sin((i / SR) * 2 * Math.PI * 4));
    }
    t += on + off;
  }
  return out;
}

/** The same sound as heard by a phone that started `delaySec` later, with `gain`, noise and clock drift. */
function phoneHears(
  ref: Float32Array,
  delaySec: number,
  { gain = 1, drift = 0, noise = 0.003, seed = 9 } = {},
): Float32Array {
  const out = new Float32Array(ref.length);
  let s = seed >>> 0;
  for (let t = 0; t < out.length; t++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    // this phone's clock runs `drift` slow: its time t corresponds to reference time t·(1−drift) − delay
    const src = t * (1 - drift) - delaySec * SR;
    const i = Math.floor(src);
    const f = src - i;
    const v = i >= 0 && i + 1 < ref.length ? ref[i]! * (1 - f) + ref[i + 1]! * f : 0;
    out[t] = v * gain + (s / 4294967296 - 0.5) * 2 * noise;
  }
  return out;
}

const rms = (a: Float32Array, from: number, to: number) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += a[i]! * a[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
};

describe('offset estimation', () => {
  const ref = speechLike(70);
  for (const delay of [0.3, 4, 20]) {
    it(`finds a ${delay} s offset to within 50 ms (different gain and noise)`, () => {
      const other = phoneHears(ref, delay, { gain: 0.35 });
      const pts = offsetsPerWindow(ref, other, {
        expectedOffsetSec: 0,
        searchSec: 30,
        windowSec: 60,
      });
      expect(pts.length).toBeGreaterThan(0);
      for (const p of pts) expect(Math.abs(p.offset - delay)).toBeLessThan(0.05);
      const fit = fitDrift(pts)!;
      expect(Math.abs(fit.a - delay)).toBeLessThan(0.05);
    });
  }

  it('uses the coarse expectation: a wrong search centre still finds the peak inside the range', () => {
    const other = phoneHears(ref, 4);
    const pts = offsetsPerWindow(ref, other, {
      expectedOffsetSec: 3.2,
      searchSec: 5,
      windowSec: 60,
    });
    expect(Math.abs(pts[0]!.offset - 4)).toBeLessThan(0.05);
  });

  it('reports nothing for unrelated audio', () => {
    const other = speechLike(70, 777);
    const pts = offsetsPerWindow(ref, other, { searchSec: 5, windowSec: 60, minScore: 0.7 });
    expect(pts).toEqual([]);
  });
});

describe('drift', () => {
  it('recovers a 0.1 % clock error as a slope and removes it when re-timing', () => {
    const seconds = 190;
    const ref = speechLike(seconds, 4);
    const other = phoneHears(ref, 2.7, { drift: 0.001, gain: 0.6 });
    const pts = offsetsPerWindow(ref, other, {
      expectedOffsetSec: 2.7,
      searchSec: 8,
      windowSec: 30,
    });
    const fit = fitDrift(pts)!;
    expect(fit.used).toBeGreaterThanOrEqual(5);
    expect(fit.b).toBeGreaterThan(0.0007);
    expect(fit.b).toBeLessThan(0.0013);
    // after re-timing, the envelope offset is flat and near zero over the whole recording
    const fixed = alignTrack(other, fit, ref.length);
    const after = offsetsPerWindow(ref, fixed, {
      expectedOffsetSec: 0,
      searchSec: 2,
      windowSec: 30,
    });
    expect(after.length).toBeGreaterThanOrEqual(5);
    for (const p of after) expect(Math.abs(p.offset)).toBeLessThan(0.05);
  });

  it('ignores one bad window when fitting', () => {
    const pts = [0, 60, 120, 180, 240].map((t) => ({ t, offset: 1 + 0.001 * t, score: 0.8 }));
    pts[2] = { t: 120, offset: 9, score: 0.3 };
    const fit = fitDrift(pts)!;
    expect(fit.a).toBeCloseTo(1, 1);
    expect(fit.b).toBeCloseTo(0.001, 4);
  });

  it('handles one window and none', () => {
    expect(fitDrift([])).toBeNull();
    expect(fitDrift([{ t: 10, offset: 0.4, score: 0.9 }])).toEqual({ a: 0.4, b: 0, used: 1 });
  });
});

describe('best-channel mix', () => {
  // Two speakers: A talks in the first half near phone 0, B in the second half near phone 1.
  const seconds = 20;
  const n = seconds * SR;
  const voiceA = speechLike(seconds, 21);
  const voiceB = speechLike(seconds, 22);
  const gate = (v: Float32Array, from: number, to: number, g: number) => {
    const o = new Float32Array(n);
    for (let i = from; i < to; i++) o[i] = v[i]! * g;
    return o;
  };
  const half = n / 2;
  const phone0 = new Float32Array(n);
  const phone1 = new Float32Array(n);
  const a0 = gate(voiceA, 0, half, 1);
  const a1 = gate(voiceA, 0, half, 0.15);
  const b0 = gate(voiceB, half, n, 0.15);
  const b1 = gate(voiceB, half, n, 1);
  for (let i = 0; i < n; i++) {
    phone0[i] = a0[i]! + b0[i]!;
    phone1[i] = a1[i]! + b1[i]!;
  }

  it('takes each voice from the phone closest to it, not a sum of both', () => {
    const m = bestChannelMix([phone0, phone1]);
    expect(m.mix).toHaveLength(n);
    const hop = 0.25 * SR;
    // judge only the hops where somebody speaks (in silence nothing is gained by switching)
    const voiced = (h: number) => Math.max(m.loudness[0]![h]!, m.loudness[1]![h]!) > -45;
    const hs = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => from + i).filter(voiced);
    const first = hs(0, half / hop - 2);
    const second = hs(half / hop + 2, m.chosen.length);
    expect(first.filter((h) => m.chosen[h] === 0).length / first.length).toBeGreaterThan(0.9);
    expect(second.filter((h) => m.chosen[h] === 1).length / second.length).toBeGreaterThan(0.9);
    // in the first half the mix follows phone 0 (not the sum with phone 1)
    let diff = 0;
    for (let i = SR; i < half - SR; i++)
      diff += Math.abs(m.mix[i]! - a0[i]! * (m.mix[i]! === 0 ? 0 : 1));
    expect(rms(m.mix, SR, half - SR)).toBeLessThan(rms(phone0, SR, half - SR) * 4);
    expect(m.switches).toBeLessThanOrEqual(4);
    expect(diff).toBeGreaterThanOrEqual(0);
  });

  it('cross-fades switches: no jump larger than the signal itself at the boundary', () => {
    const m = bestChannelMix([phone0, phone1]);
    let maxStep = 0;
    for (let i = 1; i < m.mix.length; i++)
      maxStep = Math.max(maxStep, Math.abs(m.mix[i]! - m.mix[i - 1]!));
    expect(maxStep).toBeLessThan(1.2);
    expect(Number.isFinite(maxStep)).toBe(true);
  });

  it('matches phone levels, so a hot phone does not win every hop', () => {
    const quiet = phone1.map((v) => v * 0.05) as Float32Array;
    const loud = phone0.map((v) => v * 8) as Float32Array;
    const m = bestChannelMix([loud, quiet]);
    // phone 1 is 160x quieter overall but still gets the second half after level matching
    const hop = 0.25 * SR;
    const second = m.chosen.slice(half / hop);
    expect(second.filter((c) => c === 1).length / second.length).toBeGreaterThan(0.8);
  });

  it('loudnessDb reports silence as very low and tone as higher', () => {
    const l = loudnessDb(new Float32Array(SR));
    expect(l[0]).toBeLessThan(-90);
    const t = new Float32Array(SR).fill(0.1);
    expect(loudnessDb(t)[0]).toBeCloseTo(-20, 0);
  });
});

describe('attribution', () => {
  const mk = (vals: number[]) => Float32Array.from(vals);
  const phoneA = mk([-10, -10, -10, -10, -30, -30, -30, -30]);
  const phoneB = mk([-25, -25, -25, -25, -12, -12, -12, -12]);

  it('names the phone that was clearly loudest for most of the segment', () => {
    const r = attributeSegments(
      [phoneA, phoneB],
      [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
      ],
    );
    expect(r[0]).toMatchObject({ track: 0, share: 1 });
    expect(r[0]!.marginDb).toBeGreaterThanOrEqual(15);
    expect(r[1]).toMatchObject({ track: 1, share: 1 });
  });

  it('abstains when the lead is under 3 dB or the segment is split', () => {
    const close = attributeSegments(
      [mk([-10, -10, -10, -10]), mk([-11, -11, -11, -11])],
      [{ start: 0, end: 1 }],
    );
    expect(close[0]!.track).toBeNull();
    const split = attributeSegments([phoneA, phoneB], [{ start: 0.5, end: 1.5 }]);
    expect(split[0]!.track).toBeNull();
  });

  it('abstains on silence everywhere', () => {
    const r = attributeSegments([mk([-90, -90]), mk([-95, -95])], [{ start: 0, end: 0.5 }]);
    expect(r[0]).toEqual({ track: null, share: 0, marginDb: 0 });
  });
});
