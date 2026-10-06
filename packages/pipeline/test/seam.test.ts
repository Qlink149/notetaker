import { describe, expect, it } from 'vitest';
import { mergeChunkTurns } from '../src/seam.js';
import { sentences as s, turn } from './helpers.js';

const overlap = { start: 570, end: 600 }; // midpoint 585

describe('mergeChunkTurns', () => {
  it('keeps earlier turns before the midpoint and later turns after it', () => {
    const prev = [
      turn('G1', 560, 568, s[0]!),
      turn('G1', 575, 582, s[1]!),
      turn('G2', 590, 598, s[2]!),
    ];
    const next = [
      turn('G1', 576, 583, s[1]!),
      turn('G2', 590, 598, s[2]!),
      turn('G2', 605, 612, s[3]!),
    ];
    const merged = mergeChunkTurns(prev, next, overlap);
    expect(merged.map((t) => t.textRoman)).toEqual([s[0], s[1], s[2], s[3]]);
  });

  it('drops a later duplicate shifted by ~6 s of drift across the midpoint', () => {
    // earlier chunk heard the sentence at 581 (before mid), later chunk places it at 587
    const prev = [turn('G1', 581, 584, s[4]!)];
    const next = [turn('G1', 587, 590, s[4]!), turn('G2', 592, 596, s[5]!)];
    const merged = mergeChunkTurns(prev, next, overlap);
    expect(merged.map((t) => t.textRoman)).toEqual([s[4], s[5]]);
  });

  it('drops near-duplicates with small wording differences', () => {
    const prev = [turn('G1', 583, 586, 'Kisna ka franchise model bahut strong hai na')];
    const next = [turn('G1', 586, 589, 'Kisna ka franchise model bahut strong hai')];
    expect(mergeChunkTurns(prev, next, overlap)).toHaveLength(1);
  });

  it('keeps genuinely different speech near the seam', () => {
    const prev = [turn('G1', 583, 586, s[6]!)];
    const next = [turn('G2', 586, 589, s[7]!)];
    expect(mergeChunkTurns(prev, next, overlap)).toHaveLength(2);
  });

  it('does not dedupe repeats far from each other', () => {
    const prev = [turn('G1', 572, 575, s[8]!)];
    const next = [turn('G1', 595, 598, s[8]!)];
    expect(mergeChunkTurns(prev, next, overlap)).toHaveLength(2);
  });

  it('concatenates when there is no overlap', () => {
    const prev = [turn('G1', 0, 5, s[0]!)];
    const next = [turn('G2', 700, 705, s[1]!)];
    expect(mergeChunkTurns(prev, next, { start: 650, end: 600 })).toHaveLength(2);
  });
});
