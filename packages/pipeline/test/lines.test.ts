import { describe, expect, it } from 'vitest';
import { splitLongTurn, turnsToLines } from '../src/lines.js';
import { turn } from './helpers.js';

const map = { S1: 'Speaker 1', S2: 'Speaker 2' };

describe('turnsToLines', () => {
  it('merges consecutive same-speaker turns across a short pause', () => {
    const lines = turnsToLines([turn('S1', 0, 5, 'pehla'), turn('S1', 5.8, 9, 'doosra')], map);
    expect(lines).toEqual([
      {
        speakerName: 'Speaker 1',
        start: 0,
        end: 9,
        textRoman: 'pehla doosra',
        textNative: 'pehla doosra',
      },
    ]);
  });

  it('starts a new line after a pause of 1.2 s or more', () => {
    const lines = turnsToLines([turn('S1', 0, 5, 'a'), turn('S1', 6.2, 9, 'b')], map);
    expect(lines).toHaveLength(2);
  });

  it('starts a new line when the speaker changes mid-sentence', () => {
    const lines = turnsToLines(
      [turn('S1', 0, 3, 'to hum ye'), turn('S2', 3, 4, 'haan'), turn('S1', 4, 7, 'karenge')],
      map,
    );
    expect(lines.map((l) => l.speakerName)).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 1']);
  });

  it('never merges past 45 s', () => {
    const turns = Array.from({ length: 20 }, (_, i) => turn('S1', i * 5, i * 5 + 4.5, `part ${i}`));
    const lines = turnsToLines(turns, map);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.end - l.start).toBeLessThanOrEqual(45);
  });

  it('splits a single turn longer than 45 s', () => {
    const text = Array.from({ length: 120 }, (_, i) => (i % 20 === 19 ? `w${i}.` : `w${i}`)).join(
      ' ',
    );
    const lines = turnsToLines([turn('S1', 100, 220, text)], map);
    expect(lines.length).toBe(3);
    for (const l of lines) expect(l.end - l.start).toBeLessThanOrEqual(45);
    expect(lines[0]!.start).toBe(100);
    expect(lines.at(-1)!.end).toBe(220);
    expect(lines.map((l) => l.textRoman).join(' ')).toBe(text);
  });

  it('falls back to the raw label when the map has no name', () => {
    expect(turnsToLines([turn('S9', 0, 1, 'x')], map)[0]!.speakerName).toBe('S9');
  });
});

describe('splitLongTurn', () => {
  it('prefers cutting after sentence punctuation', () => {
    const t = turn('S1', 0, 60, 'one two three four five six. seven eight nine ten eleven twelve');
    const parts = splitLongTurn(t, 45);
    expect(parts.map((p) => p.textRoman)).toEqual([
      'one two three four five six.',
      'seven eight nine ten eleven twelve',
    ]);
  });

  it('keeps native and roman pieces aligned in count', () => {
    const t = { ...turn('S1', 0, 100, 'a b c d e f'), textNative: 'अ ब स द इ फ' };
    const parts = splitLongTurn(t, 45);
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.textNative && p.textRoman)).toBe(true);
  });
});
