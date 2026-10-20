import { describe, expect, it } from 'vitest';
import { carrySpeakers } from '../src/carryOver.js';

const seg = (speaker: string, start: number, end: number) => ({ speaker, start, end });

describe('carrySpeakers (audio added to a meeting)', () => {
  // earlier audio: 0-100 s; Heet (S0) and Paresh (S1) take turns
  const old = [seg('S0', 0, 20), seg('S1', 20, 50), seg('S0', 50, 80), seg('S1', 80, 100)];

  it('follows each decided voice to its new label', () => {
    // the longer recording swaps the labels and adds a third voice after 100 s
    const now = [
      seg('X1', 0, 21),
      seg('X0', 21, 49),
      seg('X1', 49, 80),
      seg('X0', 80, 130),
      seg('X2', 130, 200),
    ];
    expect(Object.fromEntries(carrySpeakers(old, now, 100, ['S0', 'S1']))).toEqual({
      S0: 'X1',
      S1: 'X0',
    });
  });

  it('only carries the voices a person decided', () => {
    const now = [seg('X1', 0, 20), seg('X0', 20, 50), seg('X1', 50, 80), seg('X0', 80, 100)];
    expect(Object.fromEntries(carrySpeakers(old, now, 100, ['S1']))).toEqual({ S1: 'X0' });
  });

  it('does not carry a name onto a voice that now covers two earlier people', () => {
    const now = [seg('X0', 0, 100)];
    expect(carrySpeakers(old, now, 100, ['S0']).size).toBe(0);
  });

  it('carries to the larger piece when a voice is split, but not when no piece holds half of it', () => {
    // S0's 50 s split 20/30: the 30 s piece holds more than half, and is all S0
    const split = [seg('X0', 0, 20), seg('X3', 50, 80), seg('X1', 20, 50), seg('X1', 80, 100)];
    expect(Object.fromEntries(carrySpeakers(old, split, 100, ['S0']))).toEqual({ S0: 'X3' });
    // three pieces of 15/15/20 out of 50 s: none holds half, so the voice is identified again
    const scattered = [seg('A', 0, 15), seg('B', 15, 20), seg('B', 50, 60), seg('C', 60, 80)];
    expect(carrySpeakers(old, scattered, 100, ['S0']).size).toBe(0);
  });

  it('ignores speech after the end of the earlier audio', () => {
    const now = [seg('X0', 0, 20), seg('X0', 50, 80), seg('X0', 100, 400)];
    // X0 talks for 300 s more afterwards, which says nothing against the match
    expect(Object.fromEntries(carrySpeakers(old, now, 100, ['S0']))).toEqual({ S0: 'X0' });
  });
});
