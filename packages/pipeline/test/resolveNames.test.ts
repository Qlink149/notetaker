import { describe, expect, it } from 'vitest';
import { buildScoreMatrix, resolveNames } from '../src/index.js';

const names = { ghan: 'Ghanshyam Dholakia', raj: 'Rajesh' };

describe('buildScoreMatrix', () => {
  it('takes the best of a person’s voiceprints and ignores unknown labels', () => {
    const m = buildScoreMatrix(
      [
        {
          speaker: 'SPEAKER_00',
          confidence: { 'ghan-0': 40, 'ghan-1': 85, 'raj-0': 20, stray: 99 },
        },
      ],
      { 'ghan-0': 'ghan', 'ghan-1': 'ghan', 'raj-0': 'raj' },
    );
    expect(m).toEqual({ SPEAKER_00: { ghan: 85, raj: 20 } });
  });
});

describe('resolveNames', () => {
  it('accepts a clear match and numbers the rest Unknown 1, 2 in the order given', () => {
    const r = resolveNames(
      ['S0', 'S1', 'S2'],
      { S0: { ghan: 88, raj: 20 }, S1: { ghan: 30, raj: 25 }, S2: { ghan: 10, raj: 12 } },
      { names },
    );
    expect(r.S0!).toMatchObject({
      personId: 'ghan',
      name: 'Ghanshyam Dholakia',
      status: 'accepted',
    });
    expect(r.S1!).toMatchObject({ personId: null, name: 'Unknown 1', status: 'below-threshold' });
    expect(r.S2!.name).toBe('Unknown 2');
  });

  it('gives a person to only one voice when two claim them (best total wins)', () => {
    const r = resolveNames(['S0', 'S1'], { S0: { ghan: 90 }, S1: { ghan: 75 } }, { names });
    expect(r.S0!.personId).toBe('ghan');
    expect(r.S1!.personId).toBeNull();
    expect(r.S1!.status).toBe('taken');
    expect(r.S1!.candidate).toBe('Ghanshyam Dholakia');
  });

  it('chooses the pairing with the larger total, and leaves ambiguous voices unknown', () => {
    // Greedy would give ghan to S0 (90) and raj to S1 (10). The best total gives ghan to S1 (88)
    // and raj to S0 (85); S0 still sounds more like ghan than raj, so it stays Unknown.
    const r = resolveNames(
      ['S0', 'S1'],
      { S0: { ghan: 90, raj: 85 }, S1: { ghan: 88, raj: 10 } },
      { names },
    );
    expect(r.S1!.personId).toBe('ghan');
    expect(r.S0!.personId).toBeNull();
    expect(r.S0!.status).toBe('taken');
  });

  it('rejects a match that does not lead the runner-up by the margin', () => {
    const r = resolveNames(['S0'], { S0: { ghan: 72, raj: 68 } }, { names });
    expect(r.S0!).toMatchObject({
      personId: null,
      status: 'low-margin',
      margin: 4,
      name: 'Unknown 1',
    });
  });

  it('rejects scores under the threshold even with a big margin', () => {
    const r = resolveNames(['S0'], { S0: { ghan: 55, raj: 5 } }, { names });
    expect(r.S0!.status).toBe('below-threshold');
  });

  it('marks everyone unknown when no voiceprints exist', () => {
    const r = resolveNames(['S0', 'S1'], {});
    expect(r.S0!).toMatchObject({ personId: null, name: 'Unknown 1', status: 'no-voiceprints' });
    expect(r.S1!.name).toBe('Unknown 2');
  });

  it('handles more voices than people', () => {
    const r = resolveNames(
      ['S0', 'S1', 'S2'],
      { S0: { ghan: 90 }, S1: { ghan: 20 }, S2: { ghan: 10 } },
      { names },
    );
    expect(r.S0!.personId).toBe('ghan');
    expect(r.S1!.personId).toBeNull();
    expect(r.S2!.personId).toBeNull();
  });

  it('respects custom thresholds', () => {
    const r = resolveNames(['S0'], { S0: { ghan: 55, raj: 5 } }, { names, minScore: 50 });
    expect(r.S0!.personId).toBe('ghan');
  });
});
