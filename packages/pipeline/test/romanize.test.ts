import { describe, expect, it } from 'vitest';
import { hasIndic, repairRomanLeaks, transliterateIndic } from '../src/romanize.js';
import { turnsToLines } from '../src/lines.js';
import { turn } from './helpers.js';

describe('transliterateIndic', () => {
  it.each([
    ['काम', 'kaam'],
    ['नमस्ते', 'namaste'],
    ['क', 'ka'],
    ['रहा', 'raha'],
    ['था', 'tha'],
    ['ज़रूरी', 'zaroori'],
    ['कहाँ', 'kahaan'],
    ['કામ', 'kaam'], // Gujarati
    ['છે', 'chhe'],
    ['२०२६', '2026'],
  ])('%s → %s', (input, expected) => {
    expect(transliterateIndic(input)).toBe(expected);
  });

  it('returns null for a script it has no table for', () => {
    expect(transliterateIndic('আমি')).toBeNull(); // Bengali
  });
});

describe('repairRomanLeaks', () => {
  it('leaves clean roman text untouched', () => {
    const t = turn('S1', 0, 2, 'aaj ka kaam ho gaya');
    expect(repairRomanLeaks([t])[0]).toBe(t);
    expect(hasIndic(t.textRoman)).toBe(false);
  });

  it('transliterates leaked native words in place and marks the turn', () => {
    const t = {
      ...turn('S1', 0, 2, ''),
      textRoman: 'aaj ka काम done hai',
      textNative: 'आज का काम done है',
    };
    const [fixed] = repairRomanLeaks([t]);
    expect(fixed?.textRoman).toBe('aaj ka kaam done hai');
    expect(fixed?.textNative).toBe(t.textNative);
    expect(fixed?.romanFix).toBe('transliterated');
  });

  it('flags a leak it cannot repair', () => {
    const t = { ...turn('S1', 0, 2, ''), textRoman: 'ok আমি fine' };
    expect(repairRomanLeaks([t])[0]?.romanFix).toBe('unrepaired');
  });

  it('carries the mark onto the rendered line', () => {
    const turns = repairRomanLeaks([
      turn('S1', 0, 2, 'pehli baat'),
      { ...turn('S1', 2.5, 4, ''), textRoman: 'दूसरी baat', textNative: 'दूसरी बात' },
    ]);
    const lines = turnsToLines(turns);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textRoman).toBe('pehli baat doosari baat');
    expect(lines[0]?.romanFix).toBe('transliterated');
  });
});
