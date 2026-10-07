import { describe, expect, it } from 'vitest';
import { seededRandom, shuffled, stratifiedSample, tallyAudit } from '../src/index.js';

const line = (start: number, dur: number) => ({ start, end: start + dur });

describe('seededRandom / shuffled', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = seededRandom('x');
    const b = seededRandom('x');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(seededRandom('x')()).not.toBe(seededRandom('y')());
  });
  it('shuffles without losing or duplicating items', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const out = shuffled(items, seededRandom('s'));
    expect([...out].sort((a, b) => a - b)).toEqual(items);
    expect(out).not.toEqual(items);
  });
});

describe('stratifiedSample', () => {
  const items = [
    ...Array.from({ length: 40 }, (_, i) => line(i * 10, 1.5)), // short
    ...Array.from({ length: 40 }, (_, i) => line(1000 + i * 10, 8)), // long
  ];
  it('takes a third short and the rest long', () => {
    const s = stratifiedSample(items, 15, seededRandom('a'));
    expect(s).toHaveLength(15);
    expect(s.filter((x) => x.end - x.start < 3)).toHaveLength(5);
  });
  it('fills from the other group when one is too small', () => {
    const few = [line(0, 1), ...Array.from({ length: 30 }, (_, i) => line(100 + i, 9))];
    const s = stratifiedSample(few, 15, seededRandom('a'));
    expect(s).toHaveLength(15);
    expect(s.filter((x) => x.end - x.start < 3)).toHaveLength(1);
    const onlyShort = Array.from({ length: 4 }, (_, i) => line(i * 5, 1));
    expect(stratifiedSample(onlyShort, 15, seededRandom('a'))).toHaveLength(4);
  });
  it('is stable for the same seed', () => {
    expect(stratifiedSample(items, 12, seededRandom('k'))).toEqual(
      stratifiedSample(items, 12, seededRandom('k')),
    );
  });
});

describe('tallyAudit', () => {
  it('reports rates per method, counting can’t-tell against the plain rate only', () => {
    const t = tallyAudit([
      { method: 'm1', speaker: 'right', text: 'match' },
      { method: 'm1', speaker: 'right', text: 'partly' },
      { method: 'm1', speaker: 'wrong', text: 'no' },
      { method: 'm1', speaker: 'unsure', text: 'match' },
      { method: 'm3', speaker: 'right', text: 'match' },
      { method: 'm3', speaker: null, text: null },
    ]);
    const m1 = t.find((x) => x.method === 'm1')!;
    expect(m1).toMatchObject({ items: 4, answered: 4, right: 2, wrong: 1, unsure: 1 });
    expect(m1.speakerCorrectRate).toBe(0.5);
    expect(m1.speakerCorrectRateDecided).toBe(0.667);
    expect(m1.wrongNameRate).toBe(0.25);
    expect(m1.textMatchRate).toBe(0.5);
    const m3 = t.find((x) => x.method === 'm3')!;
    expect(m3).toMatchObject({ items: 2, answered: 1, right: 1 });
    expect(m3.speakerCorrectRate).toBe(1);
  });
  it('returns null rates when nothing was answered', () => {
    const [t] = tallyAudit([{ method: 'm1', speaker: null, text: null }]);
    expect(t!.speakerCorrectRate).toBeNull();
    expect(t!.textMatchRate).toBeNull();
  });
});
