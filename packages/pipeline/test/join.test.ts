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
  keysMatch,
  labelSpeakersByTime,
  speakerAtTime,
  turnTrust,
  wordClockJoin,
  wordKey,
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
  it('does not split for an interjection shorter than 1 s', () => {
    const r = assignByOverlap(
      [turn(0, 10, 'long sentence here')],
      [seg('A', 0, 4), seg('B', 4, 4.8), seg('A', 4.8, 10)],
    );
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]!.speaker).toBe('A');
  });
  it('takes the nearest segment for a turn in a gap, and unknown beyond 2 s', () => {
    const gapSegs = [seg('A', 0, 5), seg('B', 20, 25)];
    expect(assignByOverlap([turn(6, 7, 'x')], gapSegs).turns[0]!.speaker).toBe('A');
    expect(assignByOverlap([turn(10, 12, 'x')], gapSegs).turns[0]!.speaker).toBe('unknown');
  });
  it('keeps the majority speaker when the minority side is under 1 s', () => {
    const r = assignByOverlap([turn(0, 10, 'x y z')], [seg('A', 0, 0.8), seg('B', 0.8, 10)]);
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

describe('phonetic word keys', () => {
  it('match English words Gemini writes in Devanagari to Deepgram’s Latin spelling', () => {
    for (const [dev, latin] of [
      ['प्रिंट', 'print'],
      ['डिजिटल', 'digital'],
      ['टीवी', 'TV'],
      ['मीडियम', 'medium'],
      ['पर्सेंट', 'percent'],
      ['कन्वेंशनल', 'conventional'],
    ] as const)
      expect(keysMatch(wordKey(dev), wordKey(latin)), `${dev} / ${latin}`).toBe(true);
  });
  it('do not match unrelated words, short function words, or two Latin words of one letter class', () => {
    expect(keysMatch(wordKey('गया'), wordKey('बजट'))).toBe(false);
    expect(keysMatch(wordKey('है'), wordKey('he'))).toBe(false);
    expect(keysMatch(wordKey('का'), wordKey('ka'))).toBe(false);
    expect(keysMatch(wordKey('budget'), wordKey('print'))).toBe(false);
  });
});

describe('speakerAtTime', () => {
  const segs = [seg('A', 0, 5), seg('B', 8, 12)];
  it('finds the containing segment, else the nearest within the gap, else null', () => {
    expect(speakerAtTime(segs, 3, 0.5)).toBe('A');
    expect(speakerAtTime(segs, 5.3, 0.5)).toBe('A');
    expect(speakerAtTime(segs, 6.5, 0.5)).toBeNull();
    expect(speakerAtTime(segs, 10, 0.5)).toBe('B');
  });
});

describe('word clock: words without a Deepgram match', () => {
  const text = 'a1 a2 a3 a4 m1 m2 m3 m4 z1 z2 z3 z4';
  // Deepgram heard only the first and last four words, both from speaker A
  const dg = (): TimedWord[] => [
    ...words('a1 a2 a3 a4', 0, 4).map((w) => ({ ...w, speaker: 'A' })),
    ...words('z1 z2 z3 z4', 8, 12).map((w) => ({ ...w, speaker: 'A' })),
  ];
  it('keep the surrounding speaker when another voice has only a short flicker there', () => {
    const r = wordClockJoin([turn(0, 12, text)], dg(), {
      segments: [seg('A', 0, 12), seg('B', 5.5, 6.1)],
      timeMode: 'index',
    });
    expect(r.tokenSpeakers[0]!.every((s) => s === 'A')).toBe(true);
  });
  it('take the other voice when pyannote has a solid segment there', () => {
    const r = wordClockJoin([turn(0, 12, text)], dg(), {
      segments: [seg('A', 0, 4), seg('B', 4, 8), seg('A', 8, 12)],
      timeMode: 'index',
    });
    expect(r.tokenSpeakers[0]!.slice(4, 8)).toEqual(['B', 'B', 'B', 'B']);
    expect(r.tokens.filter((t) => t.matched)).toHaveLength(8);
  });
});

describe('joinMeeting with Gemini’s clock off', () => {
  const t1 = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
  const t2 = 'kilo lima mike november oscar papa';
  const t3 = 'quebec romeo sierra tango uniform victor whiskey xray yankee zulu';
  const segments = [seg('A', 0, 10), seg('B', 10, 14), seg('A', 14, 24)];
  const base = {
    chunks: [{ index: 0, startSec: 0, endSec: 60 }],
    segments,
    speechSegments: [{ start: 0, end: 24 }],
  };
  const total = (ts: Turn[]) => ts.reduce((n, t) => n + t.textNative.split(' ').length, 0);

  it('shifts a turn Deepgram did not hear by the drift measured on its neighbours', () => {
    // Gemini's clock is 30 s late; Deepgram has words for turns 1 and 3 only
    const turns = [turn(30, 40, t1), turn(40, 44, t2), turn(44, 54, t3)];
    const j = joinMeeting({
      ...base,
      turns,
      dgWords: [...words(t1, 0, 10), ...words(t3, 14, 24)],
    });
    const middle = j.turns.find((t) => t.textNative.includes('kilo'))!;
    expect(middle.speaker).toBe('B');
    expect(middle.start).toBeGreaterThan(9);
    expect(middle.start).toBeLessThan(11.5);
    expect(j.turnMethods).toMatchObject({ m3: 2, m1: 1 });
    expect(total(j.turns)).toBe(total(turns));
  });

  it('does not let a few common words pull a turn into a later stretch', () => {
    // turn 2 has 20 words; Deepgram heard nothing at 10-14 s but has 3 of those words at 60 s
    const filler = Array.from({ length: 17 }, (_, i) => `filler${i}`).join(' ');
    const long = `kilo lima mike ${filler}`;
    const turns = [turn(0, 10, t1), turn(10, 14, long), turn(66, 76, t3)];
    const j = joinMeeting({
      ...base,
      chunks: [{ index: 0, startSec: 0, endSec: 90 }],
      segments: [seg('A', 0, 10), seg('B', 10, 14), seg('A', 58, 80)],
      speechSegments: [{ start: 0, end: 80 }],
      turns,
      dgWords: [...words(t1, 0, 10), ...words('kilo lima mike', 60.5, 61.5), ...words(t3, 66, 76)],
    });
    const middle = j.turns.find((t) => t.textNative.includes('kilo'))!;
    expect(middle.start).toBeLessThan(15); // 3 of 20 matches (15%) do not define the turn's time
    expect(middle.speaker).toBe('B');
    expect(total(j.turns)).toBe(total(turns));
  });

  it('never loses or duplicates words', () => {
    const turns = [turn(30, 40, t1), turn(40, 44, t2), turn(44, 54, t3)];
    const j = joinMeeting({ ...base, turns, dgWords: words(t1, 0, 10) });
    expect(total(j.turns)).toBe(total(turns));
  });
});

describe('review fixes', () => {
  const w = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');

  it('M1 keeps a turn with no text even when it spans two speakers', () => {
    const empty = { ...turn(0, 10, ''), textRoman: '' };
    const r = assignByOverlap([empty], [seg('A', 0, 5), seg('B', 5, 10)]);
    expect(r.turns).toHaveLength(1);
    expect(r.sourceIndex).toEqual([0]);
    expect(r.turns[0]!.speaker).toBe('A');
  });

  it('matches move forward through Deepgram words when a phrase repeats', () => {
    const text = 'one two three four five six seven eight nine ten';
    const r = wordClockJoin(
      [turn(0, 10, text), turn(10, 20, text)],
      [...words(text, 0, 10), ...words(text, 10, 20)],
    );
    const starts = r.tokens.map((t) => t.start);
    expect(starts.every((v, i) => i === 0 || v >= starts[i - 1]! - 1e-9)).toBe(true);
    expect(r.tokens.every((t) => t.end >= t.start)).toBe(true);
  });

  it('never gives a word a negative duration when Deepgram words overlap', () => {
    const dg: TimedWord[] = [
      { text: 'alpha', start: 10, end: 10.6, speaker: 'A' },
      { text: 'omega', start: 10.4, end: 11, speaker: 'A' },
    ];
    const r = wordClockJoin([turn(10, 11, 'alpha mid1 mid2 omega')], dg, {
      segments: [seg('A', 9, 12)],
    });
    expect(r.tokens.every((t) => t.end >= t.start)).toBe(true);
  });

  it('words before the first match take the drift of the nearest matched word, not Gemini’s clock', () => {
    // Gemini says 70-80 s, Deepgram has the last 4 words at 10-14 s; 6 leading words are unmatched
    const text = `${w(6, 'lead')} tail0 tail1 tail2 tail3`;
    const dg = words('tail0 tail1 tail2 tail3', 10, 14);
    const r = wordClockJoin([turn(70, 80, text)], dg, { segments: [seg('A', 0, 20)] });
    const lead = r.tokens.slice(0, 6);
    expect(lead.every((t) => t.start <= 10 + 1e-9)).toBe(true);
    expect(lead[0]!.start).toBeGreaterThan(-100);
  });

  const placed = (start: number, matched: boolean) => ({
    start,
    end: start + 0.3,
    speaker: 'A',
    matched,
  });

  it('turnTrust does not extrapolate when Gemini’s turn times are out of order', () => {
    const dense = w(10, 'x');
    const turns = [turn(100, 110, dense), turn(85, 95, 'solo word'), turn(90, 100, dense)];
    const tokens = [
      ...Array.from({ length: 10 }, () => placed(100, true)),
      placed(0, false),
      placed(0, false),
      ...Array.from({ length: 10 }, () => placed(97, true)),
    ];
    const t = turnTrust(turns, tokens);
    expect(t.shift.every((v) => Math.abs(v) < 1000)).toBe(true);
    expect(t.shiftKnown[1]).toBe(false);
  });

  const driftTokens = (turns: Turn[], drifts: number[]) =>
    turns.flatMap((tr, ti) =>
      Array.from({ length: 10 }, (_, k) =>
        placed(tr.start + ((k + 0.5) / 10) * 10 + drifts[ti]!, true),
      ),
    );

  it('a short run of adjacent false turns between two agreeing stretches is rejected', () => {
    const turns = [0, 10, 20, 30, 40, 50].map((at) => turn(at, at + 10, w(10, 'y')));
    const t = turnTrust(turns, driftTokens(turns, [0, 0, 200, 205, 0, 0]));
    expect(t.outlier).toEqual([false, false, true, true, false, false]);
  });

  it('a genuine jump in the drift (a chunk seam) is kept, not rejected', () => {
    const turns = [0, 10, 20, 30, 40, 50].map((at) => turn(at, at + 10, w(10, 'z')));
    const t = turnTrust(turns, driftTokens(turns, [0, 0, 0, 30, 30, 30]));
    expect(t.outlier.some(Boolean)).toBe(false);
  });
});
