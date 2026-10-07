import { describe, expect, it } from 'vitest';
import { overlapRanges, selectClips } from '../src/index.js';

const seg = (speaker: string, start: number, end: number, conf = 90) => ({
  speaker,
  start,
  end,
  confidence: { [speaker]: conf },
});

describe('overlapRanges', () => {
  it('returns the time where two or more speakers talk', () => {
    expect(overlapRanges([seg('A', 0, 10), seg('B', 8, 12), seg('C', 20, 22)])).toEqual([
      { start: 8, end: 10 },
    ]);
  });
});

describe('selectClips', () => {
  const base = { speaker: 'A', overlaps: [], meetingSec: 900 };

  it('rejects stretches shorter than 6 s', () => {
    expect(selectClips({ ...base, exclusive: [seg('A', 0, 2), seg('A', 2.2, 5)] })).toEqual([]);
  });

  it('joins neighbouring segments of one speaker into a clip, centred', () => {
    const clips = selectClips({
      ...base,
      exclusive: [seg('A', 100, 105), seg('A', 105.3, 112), seg('A', 112.2, 118)],
    });
    expect(clips).toHaveLength(1);
    expect(clips[0]!.end - clips[0]!.start).toBeCloseTo(18, 0);
  });

  it('does not join across another speaker', () => {
    const clips = selectClips({
      ...base,
      exclusive: [seg('A', 100, 104), seg('B', 104, 105), seg('A', 105, 109)],
    });
    expect(clips).toEqual([]);
  });

  it('caps a long stretch at 25 s from its middle and never exceeds 30 s', () => {
    const [c] = selectClips({ ...base, exclusive: [seg('A', 100, 160)] });
    expect(c!.end - c!.start).toBeLessThanOrEqual(30);
    expect((c!.start + c!.end) / 2).toBeCloseTo(130, 0);
  });

  it('keeps clear of overlapped speech', () => {
    const [c] = selectClips({
      ...base,
      exclusive: [seg('A', 100, 140)],
      overlaps: [{ start: 118, end: 124 }],
    });
    expect(c).toBeDefined();
    expect(c!.end <= 117.7 || c!.start >= 124.3).toBe(true);
    expect(c!.end - c!.start).toBeGreaterThanOrEqual(6);
  });

  it('prefers higher-confidence stretches and spreads clips over the meeting', () => {
    const clips = selectClips({
      ...base,
      exclusive: [
        seg('A', 50, 70, 60),
        seg('A', 100, 120, 95),
        seg('A', 400, 420, 80),
        seg('A', 800, 820, 85),
      ],
    });
    expect(clips).toHaveLength(3);
    expect(clips.map((c) => Math.round(c.start))).toEqual([100, 400, 800].map((x) => x + 0));
  });

  it('returns nothing for a speaker with no usable stretch', () => {
    expect(selectClips({ ...base, speaker: 'Z', exclusive: [seg('A', 0, 30)] })).toEqual([]);
  });
});
