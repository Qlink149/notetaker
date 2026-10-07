import { describe, expect, it } from 'vitest';
import {
  diarizationStats,
  mmss,
  overlapSeconds,
  sampleSegments,
  unionSeconds,
} from '../src/diarization.js';

const seg = (speaker: string, start: number, end: number, c?: number) => ({
  speaker,
  start,
  end,
  ...(c === undefined ? {} : { confidence: { [speaker]: c } }),
});

describe('unionSeconds / overlapSeconds', () => {
  it('merges overlapping ranges and counts double-covered time', () => {
    const segs = [seg('A', 0, 10), seg('B', 8, 12), seg('A', 20, 25)];
    expect(unionSeconds(segs)).toBe(17);
    expect(overlapSeconds(segs)).toBe(2);
  });
  it('does not count touching segments as overlap', () => {
    expect(overlapSeconds([seg('A', 0, 5), seg('B', 5, 9)])).toBe(0);
  });
  it('counts triple overlap once', () => {
    expect(overlapSeconds([seg('A', 0, 10), seg('B', 2, 6), seg('C', 4, 8)])).toBe(6);
  });
});

describe('diarizationStats', () => {
  it('reports counts, overlap share, quantiles and per-speaker time', () => {
    const s = diarizationStats([seg('A', 0, 10, 90), seg('B', 8, 12, 50), seg('A', 20, 25, 80)]);
    expect(s.speakers).toBe(2);
    expect(s.segments).toBe(3);
    expect(s.speechSec).toBe(17);
    expect(s.overlapShare).toBeCloseTo(2 / 17, 3);
    expect(s.medianSegSec).toBe(5);
    expect(s.lowConfidenceShare).toBeCloseTo(4 / 19, 3);
    expect(s.perSpeaker[0]).toEqual({ speaker: 'A', sec: 15 });
  });
  it('handles an empty list and missing confidence', () => {
    const s = diarizationStats([]);
    expect(s).toMatchObject({ speakers: 0, speechSec: 0, overlapShare: 0, medianSegSec: null });
    expect(diarizationStats([seg('A', 0, 1)]).lowConfidenceShare).toBeNull();
  });
});

describe('sampleSegments', () => {
  it('formats the first segments of the opening window in time order', () => {
    const lines = sampleSegments([seg('B', 65, 70.4), seg('A', 0, 4), seg('A', 130, 140)], 120);
    expect(lines).toEqual(['[00:00–00:04] A', '[01:05–01:10] B']);
    expect(mmss(3599.6)).toBe('60:00');
  });
});
