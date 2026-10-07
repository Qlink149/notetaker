import { describe, expect, it } from 'vitest';
import { quantile, silenceThresholdDb } from '../src/silence.js';

describe('silenceThresholdDb', () => {
  it('keeps -35 dB for clean recordings (noise floor well below it)', () => {
    expect(silenceThresholdDb(-48.4)).toBe(-35); // 200.mp3
    expect(silenceThresholdDb(-51.3)).toBe(-35); // AOM part 1
    expect(silenceThresholdDb(-70.5)).toBe(-35); // 21-9-2026
  });

  it('raises the threshold to noise floor + 10 dB on noisy recordings', () => {
    expect(silenceThresholdDb(-40.4)).toBe(-30.4); // Prachar
    expect(silenceThresholdDb(-44)).toBe(-34);
  });

  it('never goes above -25 dB', () => {
    expect(silenceThresholdDb(-30)).toBe(-25);
    expect(silenceThresholdDb(-10)).toBe(-25);
  });

  it('falls back to -35 dB when the noise floor is unknown', () => {
    expect(silenceThresholdDb(null)).toBe(-35);
    expect(silenceThresholdDb(undefined)).toBe(-35);
    expect(silenceThresholdDb(Number.NaN)).toBe(-35);
    expect(silenceThresholdDb(Number.NEGATIVE_INFINITY)).toBe(-35);
  });

  it('accepts other base, margin and cap', () => {
    expect(silenceThresholdDb(-40, { baseDb: -45, marginDb: 6, maxDb: -20 })).toBe(-34);
  });
});

describe('quantile', () => {
  it('returns the value at the given quantile', () => {
    const v = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6, 11];
    expect(quantile(v, 0.1)).toBe(2);
    expect(quantile(v, 0.5)).toBe(6);
    expect(quantile(v, 1)).toBe(11);
    expect(quantile([], 0.1)).toBeNull();
  });
});
