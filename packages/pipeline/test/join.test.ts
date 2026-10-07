import { describe, expect, it } from 'vitest';
import type { Turn } from '@meetingid/shared';
import {
  alignTokens,
  assignByOverlap,
  assignWordSpeakers,
  chooseMethods,
  chunkOwnership,
  foldWord,
  joinMeeting,
  labelSpeakersByTime,
  wordClockJoin,
  wordsMatch,
  type TimedWord,
} from '../src/index.js';

const seg = (speaker: string, start: number, end: number) => ({ speaker, start, end });
const turn = (start: number, end: number, native: string, roman = native): Turn => ({
  speaker: 'S1',
  start,
  end,
  textNative: native,
  textRoman: roman,
  lang: 'mixed',
});
/** Words of `text` spread evenly over [start, end] as Deepgram would report them. */
const words = (text: string, start: number, end: number): TimedWord[] => {
  const w = text.split(' ');
  const step = (end - start) / w.length;
  return w.map((x, i) => ({
    text: x,
    start: start + i * step,
    end: start + (i + 1) * step - 0.02,
  }));
};

describe('foldWord / wordsMatch', () => {
  it('ignores case, punctuation, nukta, long vowels and digit scripts', () => {
    expect(foldWord('Hello,')).toBe('hello');
    expect(foldWord('ज़रूर')).toBe(foldWord('जरुर'));
    expect(foldWord('१२३')).toBe('123');
    expect(foldWord('૧૨૩')).toBe('123');
  });
  it('treats Gujarati letters as their Devanagari twins', () => {
    expect(foldWord('કામ')).toBe(foldWord('काम'));
  });
  it('allows one edit only in words of four or more characters', () => {
    expect(wordsMatch('meeting', 'meetin')).toBe(true);
    expect(wordsMatch('meeting', 'meetong')).toBe(true);
    expect(wordsMatch('meeting', 'metings')).toBe(false);
    expect(wordsMatch('को', 'का')).toBe(false);
    expect(wordsMatch('', 'a')).toBe(false);
  });
});

describe('alignTokens', () => {
  it('matches through insertions, deletions and substitutions', () => {
    const a = ['one', 'two', 'three', 'four', 'five'];
    const b = ['zero', 'one', 'two', 'xxxxx', 'four', 'five', 'six'];
    // 'three' is substituted by 'xxxxx' → unmatched
    expect(alignTokens(a, b)).toEqual([1, 2, -1, 4, 5]);
  });
  it('returns -1 everywhere for empty input', () => {
    expect(alignTokens(['a'], [])).toEqual([-1]);
    expect(alignTokens([], ['a'])).toEqual([]);
  });
});

describe('M1 assignByOverlap', () => {
  const segs = [seg('A', 0, 10), seg('B', 10, 20), seg('A', 20, 30)];
  it('gives a turn the speaker with the most overlap', () => {
    const r = assignByOverlap([turn(2, 9, 'one two three four')], segs);
    expect(r.turns.map((t) => t.speaker)).toEqual(['A']);
  });
  it('splits where the speaker changes, when both sides exceed 1.5 s', () => {
    const r = assignByOverlap([turn(6, 14, 'a b c d e f g h')], segs);
    expect(r.turns.map((t) => t.speaker)).toEqual(['A', 'B']);
    expect(r.turns.map((t) => t.textNative)).toEqual(['a b c d', 'e f g h']);
    expect(r.tokenSpeakers[0]).toEqual(['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B']);
  });
  it('does not split for an interjection shorter than 1.5 s', () => {
    const r = assignByOverlap(
      [turn(0, 10, 'long sentence here')],
      [seg('A', 0, 4), seg('B', 4, 5), seg('A', 5, 10)],
    );
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]!.speaker).toBe('A');
  });
  it('takes the nearest segment for a turn in a gap, and unknown beyond 2 s', () => {
    const gapSegs = [seg('A', 0, 5), seg('B', 20, 25)];
    expect(assignByOverlap([turn(6, 7, 'x')], gapSegs).turns[0]!.speaker).toBe('A');
    expect(assignByOverlap([turn(10, 12, 'x')], gapSegs).turns[0]!.speaker).toBe('unknown');
  });
  it('keeps the majority speaker when the minority side is under 1.5 s', () => {
    const r = assignByOverlap([turn(0, 10, 'x y z')], [seg('A', 0, 1), seg('B', 1, 10)]);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]!.speaker).toBe('B');
  });
});

describe('assignWordSpeakers', () => {
  it('uses the segment containing the midpoint, then the nearest within the gap, then neighbours', () => {
    const w: TimedWord[] = [
      { text: 'a', start: 1, end: 2 },
      { text: 'b', start: 5.1, end: 5.3 }, // 0.1 s after A ends
      { text: 'c', start: 30, end: 31 }, // far from everything
    ];
    const out = assignWordSpeakers(w, [seg('A', 0, 5), seg('B', 40, 50)]);
    expect(out.map((x) => x.speaker)).toEqual(['A', 'A', 'A']); // far word inherits the closest word's speaker
  });
});

describe('M3 wordClockJoin', () => {
  const text1 = 'aaj hum quarterly sales numbers discuss karenge';
  const text2 = 'Kisna ka franchise model bahut strong hai';

  it('takes times and speakers from Deepgram even when Gemini times are drifted', () => {
    const dg = assignWordSpeakers(
      [...words(text1, 100, 108), ...words(text2, 108, 116)],
      [seg('A', 99, 108), seg('B', 108, 117)],
    );
    // Gemini says 8 s later than reality and merges both sentences into one turn.
    const r = wordClockJoin([turn(108, 124, `${text1} ${text2}`)], dg);
    expect(r.turns.map((t) => t.speaker)).toEqual(['A', 'B']);
    expect(r.turns[0]!.start).toBeCloseTo(100, 0);
    expect(r.turns[1]!.start).toBeCloseTo(108, 0);
    expect(r.turns[0]!.textNative).toBe(text1);
    expect(r.stats.matched).toBe(14);
  });

  it('splits roman text in proportion and keeps flags', () => {
    const dg = assignWordSpeakers(
      [...words(text1, 0, 7), ...words(text2, 7, 14)],
      [seg('A', 0, 7), seg('B', 7, 14)],
    );
    const r = wordClockJoin(
      [{ ...turn(0, 14, `${text1} ${text2}`, `${text1} ${text2}`), romanFix: 'transliterated' }],
      dg,
    );
    expect(r.turns.map((t) => t.textRoman)).toEqual([text1, text2]);
    expect(r.turns.every((t) => t.romanFix === 'transliterated')).toBe(true);
  });

  it('lets words Deepgram missed inherit time and speaker from their neighbours', () => {
    const dgWords = words(text1, 0, 7).filter((_, i) => i !== 3); // "sales" missing
    const dg = assignWordSpeakers(dgWords, [seg('A', 0, 8)]);
    const r = wordClockJoin([turn(0, 7, text1)], dg);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]!.speaker).toBe('A');
    expect(r.turns[0]!.textNative).toBe(text1);
    expect(r.stats.matched).toBe(6);
  });

  it('does not let a one-word interjection of another speaker split a turn', () => {
    const w = words(text1, 0, 7);
    const dg = assignWordSpeakers(w, [seg('A', 0, 2.9), seg('B', 2.9, 3.9), seg('A', 3.9, 8)]);
    const r = wordClockJoin([turn(0, 7, text1)], dg);
    expect(r.turns.map((t) => t.speaker)).toEqual(['A']);
  });

  it('copes with a turn offset by 20 s (drift) when words are aligned in order', () => {
    const dg = assignWordSpeakers(words(text1, 50, 57), [seg('A', 49, 58)]);
    const r = wordClockJoin([turn(30, 37, text1)], dg);
    expect(r.turns[0]!.start).toBeCloseTo(50, 0);
  });

  it('marks a turn whose words are mostly unmatched as time-estimated', () => {
    const dg = assignWordSpeakers(words('zzzz yyyy xxxx wwww vvvv uuuu tttt', 0, 7), [
      seg('A', 0, 8),
    ]);
    const r = wordClockJoin([turn(0, 7, text1)], dg);
    expect(r.turns[0]!.timeEstimated).toBe(true);
    expect(r.stats.matched).toBe(0);
  });
});

describe('joinMeeting', () => {
  const chunks = [
    { index: 0, startSec: 0, endSec: 60 },
    { index: 1, startSec: 30, endSec: 90 },
  ];
  it('assigns chunk ownership at the middle of the overlap', () => {
    const own = chunkOwnership(chunks);
    expect(own[0]!.to).toBe(45);
    expect(own[1]!.from).toBe(45);
  });
  it('uses M3 where Deepgram covers the speech and M1 where it does not', () => {
    const speech = [{ start: 0, end: 90 }];
    const dgWords = words('a b c d e f g h i j', 0, 60); // nothing after 60 s
    const d = chooseMethods(chunks, dgWords, speech);
    expect(d.map((x) => x.method)).toEqual(['m3', 'm1']);
  });
  it('keeps every turn exactly once and reports agreement', () => {
    const text = 'aaj hum quarterly sales numbers discuss karenge';
    const segs = [seg('A', 0, 8)];
    const j = joinMeeting({
      turns: [turn(0, 7, text)],
      chunks: [{ index: 0, startSec: 0, endSec: 60 }],
      segments: segs,
      dgWords: words(text, 0, 7),
      speechSegments: [{ start: 0, end: 8 }],
    });
    expect(j.decisions[0]!.method).toBe('m3');
    expect(j.turns).toHaveLength(1);
    expect(j.agreement.overall).toBe(1);
  });
  it('falls back to M1 for everything when there are no Deepgram words', () => {
    const j = joinMeeting({
      turns: [turn(0, 7, 'x y z')],
      chunks: [{ index: 0, startSec: 0, endSec: 60 }],
      segments: [seg('A', 0, 8)],
      dgWords: [],
      speechSegments: [{ start: 0, end: 8 }],
    });
    expect(j.decisions[0]!.method).toBe('m1');
    expect(j.agreement.overall).toBeNull();
    expect(j.turns[0]!.speaker).toBe('A');
  });
});

describe('labelSpeakersByTime', () => {
  it('orders Speaker A, B, … by speaking time', () => {
    const m = labelSpeakersByTime([seg('S_1', 0, 5), seg('S_0', 5, 30), seg('S_2', 30, 33)]);
    expect(m['S_0']).toBe('Speaker A');
    expect(m['S_1']).toBe('Speaker B');
    expect(m['S_2']).toBe('Speaker C');
    expect(m['unknown']).toBe('Unknown');
  });
  it('continues past Z', () => {
    const segs = Array.from({ length: 28 }, (_, i) => seg(`S${i}`, i * 10, i * 10 + 10 - i * 0.1));
    const m = labelSpeakersByTime(segs);
    expect(m['S26']).toBe('Speaker AA');
  });
});
