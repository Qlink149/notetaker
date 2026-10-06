import { describe, expect, it } from 'vitest';
import { computeCoverage, speechFromSilences, unionIntervals } from '../src/coverage.js';
import { turn } from './helpers.js';

describe('computeCoverage', () => {
  const speech = [
    { start: 0, end: 60 },
    { start: 70, end: 130 },
  ]; // 120 s of speech

  it('is ~1 when turns cover all speech', () => {
    const c = computeCoverage(speech, [turn('S1', 0, 60, 'x'), turn('S2', 70, 130, 'y')]);
    expect(c).toEqual({ speechSec: 120, coveredSec: 120, ratio: 1 });
  });

  it('reports the 7% case from the audit', () => {
    const c = computeCoverage(speech, [turn('S1', 10, 16.4, 'x')], 0);
    expect(c.speechSec).toBe(120);
    expect(c.coveredSec).toBeCloseTo(6.4);
    expect(c.ratio).toBeCloseTo(0.053, 3);
  });

  it('pads turns by 1 s to absorb drift but never counts silence', () => {
    const c = computeCoverage(speech, [turn('S1', 61, 69, 'x')]);
    // padded to 60..70, entirely in the silence gap
    expect(c.coveredSec).toBe(0);
  });

  it('does not double count overlapping turns', () => {
    const c = computeCoverage(speech, [turn('S1', 0, 40, 'x'), turn('S2', 20, 60, 'y')], 0);
    expect(c.coveredSec).toBe(60);
    expect(c.ratio).toBe(0.5);
  });

  it('is 0 when there is no speech at all', () => {
    expect(computeCoverage([], []).ratio).toBe(0);
  });
});

describe('speechFromSilences', () => {
  it('returns the complement of silences within the duration', () => {
    expect(
      speechFromSilences(
        [
          { start: 0, end: 2 },
          { start: 10, end: 12.5 },
          { start: 29, end: 31 },
        ],
        30,
      ),
    ).toEqual([
      { start: 2, end: 10 },
      { start: 12.5, end: 29 },
    ]);
  });

  it('treats audio with no silences as all speech', () => {
    expect(speechFromSilences([], 42)).toEqual([{ start: 0, end: 42 }]);
  });
});

describe('unionIntervals', () => {
  it('merges overlapping and touching intervals', () => {
    expect(
      unionIntervals([
        { start: 5, end: 8 },
        { start: 0, end: 3 },
        { start: 3, end: 4 },
        { start: 7, end: 9 },
      ]),
    ).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 9 },
    ]);
  });
});
