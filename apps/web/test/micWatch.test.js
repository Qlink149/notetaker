import { describe, expect, it } from 'vitest';
import { createSilenceWatch, rmsDb, SILENCE_MS } from '../src/lib/micWatch';

describe('rmsDb', () => {
  it('is the level of the samples in dBFS, and very low for silence or nothing', () => {
    expect(rmsDb(new Float32Array(100).fill(1))).toBeCloseTo(0, 5);
    expect(rmsDb(new Float32Array(100).fill(0.1))).toBeCloseTo(-20, 3);
    expect(rmsDb(new Float32Array(100))).toBeLessThanOrEqual(-99);
    expect(rmsDb(new Float32Array(0))).toBe(-100);
  });
});

describe('silence watch', () => {
  it('warns only after the microphone has stayed quiet for the whole period', () => {
    const w = createSilenceWatch();
    expect(w.update(-90, 0)).toBe(false);
    expect(w.update(-90, SILENCE_MS - 1)).toBe(false);
    expect(w.update(-90, SILENCE_MS)).toBe(true);
  });

  it('clears the moment sound returns and starts counting again from the next quiet moment', () => {
    const w = createSilenceWatch();
    w.update(-90, 0);
    expect(w.update(-90, SILENCE_MS + 1)).toBe(true);
    expect(w.update(-30, SILENCE_MS + 2)).toBe(false);
    expect(w.update(-90, SILENCE_MS + 3)).toBe(false);
    expect(w.update(-90, SILENCE_MS + 3 + SILENCE_MS)).toBe(true);
  });

  it('does not count time spent paused once reset', () => {
    const w = createSilenceWatch();
    w.update(-90, 0);
    w.reset();
    expect(w.update(-90, SILENCE_MS + 5)).toBe(false);
  });
});
