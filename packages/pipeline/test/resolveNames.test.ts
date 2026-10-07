import { describe, expect, it } from 'vitest';
import {
  buildScoreMatrix,
  buildScoreMatrixFromSegments,
  buildSpeakerLevelMatrix,
  type IdentifyOutputLike,
  resolveNames,
  type ScoredSegment,
} from '../src/index.js';

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

describe('buildScoreMatrixFromSegments', () => {
  it('weights each label by overlap time and takes the best voiceprint per person', () => {
    const own = [
      { speaker: 'A', start: 0, end: 10 },
      { speaker: 'B', start: 10, end: 20 },
    ];
    const scored: ScoredSegment[] = [
      { start: 0, end: 5, confidence: { 'p1-0': 90, 'p1-1': 70, 'p2-0': 10 } },
      { start: 5, end: 10, confidence: { 'p1-0': 50, 'p1-1': 70, 'p2-0': 10 } },
      { start: 10, end: 20, confidence: { 'p1-0': 5, 'p2-0': 88 } },
    ];
    const m = buildScoreMatrixFromSegments(own, scored, {
      'p1-0': 'p1',
      'p1-1': 'p1',
      'p2-0': 'p2',
    });
    expect(m.A).toEqual({ p1: 70, p2: 10 }); // p1-0 averages 70, p1-1 70
    expect(m.B).toEqual({ p1: 5, p2: 88 });
  });

  it('ignores identify segments without scores and speakers without overlap', () => {
    const m = buildScoreMatrixFromSegments(
      [{ speaker: 'A', start: 100, end: 110 }],
      [
        { start: 0, end: 5, confidence: { 'p1-0': 99 } },
        { start: 100, end: 110 },
      ],
      { 'p1-0': 'p1' },
    );
    expect(m).toEqual({});
  });
});

describe('buildSpeakerLevelMatrix', () => {
  const output: IdentifyOutputLike = {
    diarization: [
      { speaker: 'X', start: 0, end: 50 },
      { speaker: 'Y', start: 50, end: 100 },
    ],
    voiceprints: [
      { speaker: 'X', confidence: { 'p1-0': 90, 'p1-1': 40, 'p2-0': 20 } },
      { speaker: 'Y', confidence: { 'p1-0': 10, 'p2-0': 75 } },
    ],
  };
  const map = { 'p1-0': 'p1', 'p1-1': 'p1', 'p2-0': 'p2' };

  it('maps our speakers to the job’s speakers by time overlap, whatever the ids', () => {
    const own = [
      { speaker: 'S9', start: 1, end: 48 },
      { speaker: 'S3', start: 52, end: 99 },
    ];
    const { matrix, unmapped } = buildSpeakerLevelMatrix(own, output, map);
    expect(matrix).toEqual({ S9: { p1: 90, p2: 20 }, S3: { p1: 10, p2: 75 } });
    expect(unmapped).toEqual([]);
  });

  it('reports speakers whose speech is split across the job’s speakers', () => {
    const { matrix, unmapped } = buildSpeakerLevelMatrix(
      [{ speaker: 'S1', start: 25, end: 75 }],
      output,
      map,
    );
    expect(matrix).toEqual({});
    expect(unmapped).toEqual(['S1']);
  });
});
