import { describe, expect, it } from 'vitest';
import { pickWordClock, type TimedWord } from '../src/index.js';

// A word every second from `from` to `to` (a dense clock), or every `step` seconds (a sparse one).
const words = (from: number, to: number, tag: string, step = 1): TimedWord[] => {
  const out: TimedWord[] = [];
  for (let t = from; t < to; t += step) out.push({ text: `${tag}${t}`, start: t, end: t + 0.8 });
  return out;
};
const chunks = [
  { index: 0, startSec: 0, endSec: 100 },
  { index: 1, startSec: 90, endSec: 200 },
];
const speech = [{ start: 0, end: 200 }];

describe('picking the word clock per part (19 Oct, "200 planning" was mostly Gujarati)', () => {
  it('takes the language that heard more of each part', () => {
    // part 0 is Hindi (dense hi clock), part 1 Gujarati (dense gu clock)
    const hi = [...words(0, 100, 'h'), ...words(100, 200, 'h', 20)];
    const gu = [...words(0, 100, 'g', 20), ...words(100, 200, 'g')];
    const { words: picked, picks } = pickWordClock(
      [
        { label: 'hi', words: hi },
        { label: 'gu', words: gu },
      ],
      chunks,
      speech,
    );
    expect(picks.map((p) => p.label)).toEqual(['hi', 'gu']);
    // each part's words come from one language, split at the middle of the overlap (95 s)
    expect(picked.filter((w) => w.start < 95).every((w) => w.text.startsWith('h'))).toBe(true);
    expect(picked.filter((w) => w.start >= 95).every((w) => w.text.startsWith('g'))).toBe(true);
    // in time order, with no word twice
    expect(picked.map((w) => w.start)).toEqual(
      [...picked.map((w) => w.start)].sort((a, b) => a - b),
    );
    expect(new Set(picked.map((w) => w.text)).size).toBe(picked.length);
  });

  it('with one clock (or one with words) returns it unchanged', () => {
    const hi = words(0, 200, 'h');
    expect(pickWordClock([{ label: 'hi', words: hi }], chunks, speech).words).toBe(hi);
    expect(
      pickWordClock(
        [
          { label: 'hi', words: hi },
          { label: 'gu', words: [] },
        ],
        chunks,
        speech,
      ).words,
    ).toBe(hi);
    expect(pickWordClock([], chunks, speech).words).toEqual([]);
  });

  it('keeps the first language on a tie', () => {
    const hi = words(0, 200, 'h');
    const gu = words(0, 200, 'g');
    const { picks } = pickWordClock(
      [
        { label: 'hi', words: hi },
        { label: 'gu', words: gu },
      ],
      chunks,
      speech,
    );
    expect(picks.map((p) => p.label)).toEqual(['hi', 'hi']);
  });
});
