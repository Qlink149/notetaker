import { describe, expect, it } from 'vitest';
import { alignSeam, rescaleTurns } from '../src/align.js';
import { assembleChunks } from '../src/assemble.js';
import { sentences as s, turn } from './helpers.js';

/** Twelve distinct sentences, 5 s apart, as heard in real time. */
const speech = (from: number) =>
  s.map((text, i) => ({ start: from + i * 5, text, speaker: i % 2 ? 'B' : 'A' }));

describe('alignSeam', () => {
  it('measures a 26 s clock drift from sentences both chunks transcribed', () => {
    // Real seam at 1710–1740. The earlier chunk (1140–1740) runs 26 s late by its end.
    const truth = speech(1690);
    const prev = {
      startSec: 1140,
      endSec: 1740,
      turns: truth
        .filter((x) => x.start < 1716)
        .map((x) => turn(x.speaker, x.start + 26, x.start + 30, x.text)),
    };
    const next = {
      startSec: 1710,
      endSec: 2310,
      turns: truth
        .filter((x) => x.start >= 1710)
        .map((x) => turn(x.speaker === 'A' ? 'S2' : 'S1', x.start, x.start + 4, x.text)),
    };
    const a = alignSeam(prev, next);
    expect(a.anchors).toBeGreaterThan(0);
    expect(a.driftSec).toBeCloseTo(-26, 0);
    expect(a.scale).toBeLessThan(1);
  });

  it('ignores corrections larger than 15 %', () => {
    const prev = { startSec: 0, endSec: 600, turns: [turn('A', 590, 595, s[0]!)] };
    const next = { startSec: 570, endSec: 1170, turns: [turn('S1', 500, 505, s[0]!)] };
    expect(alignSeam(prev, next, { searchSec: 120 }).scale).toBe(1);
  });

  it('needs real sentences, not fillers, to anchor', () => {
    const prev = { startSec: 0, endSec: 600, turns: [turn('A', 580, 581, 'haan ji haan')] };
    const next = { startSec: 570, endSec: 1170, turns: [turn('S1', 575, 576, 'haan ji haan')] };
    expect(alignSeam(prev, next).anchors).toBe(0);
  });
});

describe('assembleChunks with drift', () => {
  it('neither drops nor duplicates sentences at a seam with 26 s of drift, and links speakers', () => {
    // The earlier chunk (1140–1740) hears everything up to 1740 but its clock runs ~4.4 % fast,
    // so true 1712 is reported at ~1737 (26 s late at the seam).
    const k = 626 / 600;
    const placed = (t: number) => 1140 + (t - 1140) * k;
    const early = speech(1600); // 1600..1655, before the overlap
    const seam = speech(1712); // 1712..1767, inside and after the overlap
    const prev = {
      startSec: 1140,
      endSec: 1740,
      turns: [
        ...early.map((x) =>
          turn(x.speaker, placed(x.start), placed(x.start + 4), `${x.text} (early)`),
        ),
        ...seam
          .filter((x) => x.start < 1740)
          .map((x) => turn(x.speaker, placed(x.start), placed(x.start + 4), x.text)),
      ].sort((a, b) => a.start - b.start),
    };
    const next = {
      startSec: 1710,
      endSec: 2310,
      turns: seam.map((x) => turn(x.speaker === 'A' ? 'S2' : 'S1', x.start, x.start + 4, x.text)),
    };
    const { turns, seams } = assembleChunks([prev, next]);
    expect(seams[0]!.anchors).toBeGreaterThan(0);
    const texts = turns.map((t) => t.textRoman);
    for (const x of seam) expect(texts.filter((t) => t === x.text)).toHaveLength(1); // no drop, no duplicate
    expect(new Set(turns.map((t) => t.speaker)).size).toBe(2); // A/B linked to S2/S1
    for (let i = 1; i < turns.length; i++)
      expect(turns[i]!.start).toBeGreaterThanOrEqual(turns[i - 1]!.start);
  });
});

describe('rescaleTurns', () => {
  it('scales around the chunk start', () => {
    expect(
      rescaleTurns([turn('A', 1140, 1150, 'x'), turn('A', 1740, 1745, 'y')], 1140, 0.95).map(
        (t) => t.start,
      ),
    ).toEqual([1140, 1710]);
  });
});
