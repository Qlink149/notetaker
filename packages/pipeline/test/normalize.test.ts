import { describe, expect, it } from 'vitest';
import { looksLikeMinuteSeconds, normalizeChunkTurns, type RawTurn } from '../src/normalize.js';
import { AnonymousResolver } from '../src/speakers.js';
import { chunkTranscript, formatLinesForSummary } from '../src/summaryInput.js';

const raw = (speaker: string, start: number, end: number, text = 'kuch baat'): RawTurn => ({
  speaker,
  start,
  end,
  text_native: text,
  text_roman: text,
  lang: 'hi',
});

describe('normalizeChunkTurns', () => {
  it('re-bases times by the chunk offset', () => {
    const turns = normalizeChunkTurns([raw('S1', 1, 4), raw('S2', 5, 9)], 600, 570);
    expect(turns.map((t) => [t.start, t.end])).toEqual([
      [571, 574],
      [575, 579],
    ]);
  });

  it('clamps times into the chunk and forces non-decreasing starts', () => {
    const turns = normalizeChunkTurns(
      [raw('S1', 10, 20), raw('S1', 8, 12), raw('S2', 590, 612)],
      600,
      0,
    );
    expect(turns.map((t) => [t.start, t.end])).toEqual([
      [10, 20],
      [10, 12],
      [590, 600],
    ]);
  });

  it('drops empty turns and fills one script from the other', () => {
    const turns = normalizeChunkTurns(
      [raw('S1', 0, 1, ''), { ...raw('S1', 1, 2), text_native: 'नमस्ते', text_roman: '' }],
      600,
      0,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]!.textRoman).toBe('नमस्ते');
  });

  it('gives a zero-length turn a plausible duration', () => {
    const [t] = normalizeChunkTurns([raw('S1', 5, 5, 'ek do teen chaar paanch')], 600, 0);
    expect(t!.end - t!.start).toBeCloseTo(2);
  });

  it('repairs minute.second timestamps', () => {
    const turns = [raw('S1', 0.05, 0.4), raw('S2', 1.15, 2.3), raw('S1', 7.45, 9.59)];
    expect(looksLikeMinuteSeconds(turns, 600)).toBe(true);
    expect(normalizeChunkTurns(turns, 600, 0).map((t) => t.start)).toEqual([5, 75, 465]);
  });

  it('leaves real second timestamps alone', () => {
    expect(
      looksLikeMinuteSeconds([raw('S1', 0, 30), raw('S2', 31, 300), raw('S1', 301, 590)], 600),
    ).toBe(false);
  });
});

describe('AnonymousResolver', () => {
  it('maps S-labels to Speaker n and names nobody', async () => {
    const r = await new AnonymousResolver().resolve({
      turns: [
        { speaker: 'S2', start: 0, end: 1, textNative: '', textRoman: 'a', lang: 'en' },
        { speaker: 'S1', start: 1, end: 2, textNative: '', textRoman: 'b', lang: 'en' },
      ],
      analysisUrl: null,
    });
    expect(r).toEqual({
      speakerMap: { S2: 'Speaker 2', S1: 'Speaker 1' },
      participants: [],
      unknownCount: 2,
    });
  });
});

describe('summary input', () => {
  it('formats lines as [mm:ss] Speaker: roman text', () => {
    const text = formatLinesForSummary([
      { speakerName: 'Speaker 1', start: 65, end: 70, textRoman: 'namaste', textNative: 'नमस्ते' },
      { speakerName: 'Speaker 2', start: 3725, end: 3730, textRoman: 'hello', textNative: 'hello' },
    ]);
    expect(text).toBe('[01:05] Speaker 1: namaste\n[1:02:05] Speaker 2: hello');
  });

  it('chunks on line boundaries', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    const parts = chunkTranscript(text, 100);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts.join('\n')).toBe(text);
  });
});

describe('timestamps', () => {
  it('parses seconds and MM:SS / H:MM:SS strings', async () => {
    const { parseTimestamp } = await import('../src/normalize.js');
    expect(parseTimestamp(12.5)).toBe(12.5);
    expect(parseTimestamp('12.5')).toBe(12.5);
    expect(parseTimestamp('09:14.2')).toBeCloseTo(554.2);
    expect(parseTimestamp('1:02:03')).toBe(3723);
    expect(parseTimestamp('soon')).toBeNaN();
    expect(parseTimestamp('1:xx')).toBeNaN();
  });

  it('rescales a clock that runs past the end of the chunk instead of piling turns on the last second', async () => {
    const { normalizeChunkTurns, overshootScale } = await import('../src/normalize.js');
    // model clock 1.5x fast: true 0..600 s reported as 0..900 s
    const raw = Array.from({ length: 10 }, (_, i) => ({
      speaker: 'S1',
      start: i * 90,
      end: i * 90 + 80,
      text_native: `t${i}`,
      text_roman: `t${i}`,
      lang: 'hi' as const,
    }));
    expect(overshootScale(raw, 600)).toBeCloseTo(600 / 890);
    const turns = normalizeChunkTurns(raw, 600, 0);
    const piled = turns.filter((t) => t.start === 600).length;
    expect(piled).toBe(0);
    expect(turns.at(-1)!.end).toBeCloseTo(600, 0);
    expect(turns[5]!.start).toBeCloseTo(450 * (600 / 890), 1);
  });

  it('leaves a clock within 3 % of the chunk alone', async () => {
    const { overshootScale } = await import('../src/normalize.js');
    expect(overshootScale([{ start: 0, end: 610 }], 600)).toBe(1);
  });
});
