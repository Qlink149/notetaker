import { describe, expect, it } from 'vitest';
import { applyGapFills, classifyGap, findTranscriptGaps, mergeGapTurns } from '../src/gaps.js';
import { sentences as s, turn } from './helpers.js';

describe('findTranscriptGaps', () => {
  const speech = [
    { start: 0, end: 60 },
    { start: 62, end: 100 },
  ];

  it('returns uncovered speech of at least 5 s, longest first', () => {
    const turns = [turn('S1', 0, 20, s[0]!), turn('S1', 40, 70, s[1]!), turn('S2', 95, 100, s[2]!)];
    const gaps = findTranscriptGaps(speech, turns);
    expect(gaps).toEqual([
      { start: 71, end: 94, speechSec: 23 },
      { start: 21, end: 39, speechSec: 18 },
    ]);
  });

  it('ignores short uncovered bits and silence', () => {
    const turns = [turn('S1', 0, 57, s[0]!), turn('S1', 64, 100, s[1]!)];
    expect(findTranscriptGaps(speech, turns)).toEqual([]);
  });

  it('classifies gaps at a chunk overlap as seam', () => {
    const chunks = [
      { startSec: 0, endSec: 600 },
      { startSec: 570, endSec: 1170 },
    ];
    expect(classifyGap({ start: 560, end: 580 }, chunks)).toBe('seam');
    expect(classifyGap({ start: 300, end: 320 }, chunks)).toBe('mid-chunk');
  });
});

describe('gap merging', () => {
  const gap = { start: 100, end: 130 };

  it('keeps only turns inside the gap and drops repeats of the padding', () => {
    const turns = [turn('S1', 90, 99, s[0]!), turn('S2', 131, 140, s[1]!)];
    const fill = [
      turn('X', 95, 99, s[0]!),
      turn('X', 101, 110, s[2]!),
      turn('Y', 112, 128, s[3]!),
      turn('Y', 131, 135, s[1]!),
    ];
    expect(mergeGapTurns(turns, fill, gap).map((t) => t.textRoman)).toEqual([
      s[0],
      s[2],
      s[3],
      s[1],
    ]);
  });

  it('links gap speakers through the padding and renumbers labels', () => {
    const turns = [turn('S1', 90, 99, s[0]!), turn('S2', 131, 140, s[1]!)];
    const fill = {
      ...gap,
      cutStart: 95,
      cutEnd: 135,
      turns: [
        turn('A', 92, 99, s[0]!),
        turn('A', 101, 110, s[2]!),
        turn('B', 112, 128, s[3]!),
        turn('B', 131, 139, s[1]!),
      ],
    };
    const out = applyGapFills(turns, [fill]);
    expect(out.map((t) => [t.speaker, t.textRoman])).toEqual([
      ['S1', s[0]],
      ['S1', s[2]],
      ['S2', s[3]],
      ['S2', s[1]],
    ]);
  });
});
