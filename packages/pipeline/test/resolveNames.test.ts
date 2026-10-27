import { describe, expect, it } from 'vitest';
import {
  buildScoreMatrix,
  buildScoreMatrixFromSegments,
  buildSpeakerLevelMatrix,
  type IdentifyOutputLike,
  type IdentifyVoiceprintScores,
  resistHubPeople,
  resolveNames,
  type ScoreMatrix,
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

/** The scorer before hub resistance: the highest voiceprint of a person, whatever the others say. */
function maxOfVoiceprints(
  voiceprints: IdentifyVoiceprintScores[],
  labelToPerson: Record<string, string>,
): ScoreMatrix {
  const matrix: ScoreMatrix = {};
  for (const v of voiceprints) {
    const row: Record<string, number> = {};
    for (const [label, score] of Object.entries(v.confidence ?? {})) {
      const person = labelToPerson[label];
      if (!person) continue;
      row[person] = Math.max(row[person] ?? Number.NEGATIVE_INFINITY, score);
    }
    matrix[v.speaker] = row;
  }
  return matrix;
}

/** Share of speakers offered as a near miss for `personId` (score at least 60, not named automatically). */
function nearMissRate(matrix: ScoreMatrix, speakers: string[], personId: string): number {
  const resolved = resolveNames(speakers, matrix, { minScore: 75, minMargin: 10 });
  const hits = speakers.filter((s) => {
    const row = resolved[s];
    return (
      row?.status === 'below-threshold' && row.candidateId === personId && row.candidateScore >= 60
    );
  });
  return hits.length / speakers.length;
}

describe('a profile that wins too often', () => {
  const speakers = Array.from({ length: 10 }, (_, i) => `S${i}`);
  const map: Record<string, string> = { 'meet-0': 'meet', 'raj-0': 'raj', 'h-hub': 'hub' };
  for (let v = 0; v < 8; v++) map[`h-${v}`] = 'hub';

  // Eight voiceprints. On six speakers a different one of them scores 65 and the rest score like a
  // non-match. Taking the max makes that profile the near miss for 60% of the room.
  const loneSpikes: IdentifyVoiceprintScores[] = speakers.map((speaker, i) => {
    const confidence: Record<string, number> = { 'meet-0': i === 9 ? 88 : 22, 'raj-0': 30 };
    for (let v = 0; v < 8; v++) confidence[`h-${v}`] = 32;
    if (i < 6) confidence[`h-${i}`] = 65;
    return { speaker, confidence };
  });

  // One voiceprint sits around 65 for six speakers and nowhere near a confident match.
  const flatHub: IdentifyVoiceprintScores[] = speakers.map((speaker, i) => ({
    speaker,
    confidence: {
      'h-hub': i < 6 ? 65 : 40,
      'h-0': 28,
      'meet-0': i === 9 ? 88 : 24,
      'raj-0': 30,
    },
  }));

  // The 65 and the next score are close, and no single voiceprint is high for half the room.
  // The max is still 65 for six speakers.
  const spreadHub: IdentifyVoiceprintScores[] = speakers.map((speaker, i) => {
    const confidence: Record<string, number> = { 'meet-0': i === 9 ? 88 : 22, 'raj-0': 30 };
    for (let v = 0; v < 8; v++) confidence[`h-${v}`] = 30;
    if (i < 6) {
      confidence[`h-${i}`] = 65;
      confidence[`h-${(i + 1) % 8}`] = 55;
    }
    return { speaker, confidence };
  });

  it('suggests the crowded profile for 60% of unrelated speakers when every voiceprint can win', () => {
    expect(nearMissRate(maxOfVoiceprints(loneSpikes, map), speakers, 'hub')).toBe(0.6);
    expect(nearMissRate(maxOfVoiceprints(flatHub, map), speakers, 'hub')).toBe(0.6);
    expect(nearMissRate(maxOfVoiceprints(spreadHub, map), speakers, 'hub')).toBe(0.6);
  });

  it('stops that profile being the near miss, and still names a real match', () => {
    for (const rows of [loneSpikes, flatHub, spreadHub]) {
      const matrix = buildScoreMatrix(rows, map);
      expect(nearMissRate(matrix, speakers, 'hub')).toBe(0);
      const named = resolveNames(speakers, matrix, { minScore: 75, minMargin: 10 });
      expect(named.S9).toMatchObject({ personId: 'meet', status: 'accepted' });
    }
  });

  it('still offers one near miss, and keeps a confident score that has weaker voiceprints beside it', () => {
    const near = buildScoreMatrix(
      [
        { speaker: 'S0', confidence: { 'p-0': 68 } },
        { speaker: 'S1', confidence: { 'p-0': 20 } },
        { speaker: 'S2', confidence: { 'p-0': 22 } },
      ],
      { 'p-0': 'p' },
    );
    expect(nearMissRate(near, ['S0', 'S1', 'S2'], 'p')).toBeCloseTo(1 / 3);
    expect(near.S0).toEqual({ p: 68 });

    const agreed = buildScoreMatrix(
      [{ speaker: 'S0', confidence: { 'h-0': 70, 'h-1': 66, 'h-2': 40, 'h-3': 30 } }],
      map,
    );
    expect(agreed.S0?.hub).toBe(70);

    const confident = buildScoreMatrix(
      [{ speaker: 'S0', confidence: { 'h-0': 88, 'h-1': 40, 'h-2': 30, 'h-3': 25 } }],
      map,
    );
    expect(confident.S0?.hub).toBe(88);
  });

  it('keeps two confident scores for one person so a split voice can still be named', () => {
    const matrix = buildScoreMatrix(
      [
        { speaker: 'S0', confidence: { 'h-0': 89, 'raj-0': 20 } },
        { speaker: 'S1', confidence: { 'h-0': 87, 'raj-0': 18 } },
      ],
      map,
    );
    expect(matrix).toEqual({ S0: { hub: 89, raj: 20 }, S1: { hub: 87, raj: 18 } });
    const named = resolveNames(['S0', 'S1'], matrix, { minScore: 75, minMargin: 10 });
    expect([named.S0?.personId, named.S1?.personId].filter(Boolean)).toEqual(['hub']);
  });

  it('drops a near miss that stays under half in each scoring half and reaches half once joined', () => {
    const half = (ids: number[], highCount: number): ScoreMatrix => {
      const matrix: ScoreMatrix = {};
      for (const i of ids) matrix[`S${i}`] = { hub: i < highCount ? 65 : 30, meet: 20 };
      return matrix;
    };
    const mapped = resistHubPeople(half([0, 1, 2, 3, 4, 5, 6, 7, 8], 4));
    const unmapped = half([9], 10);
    expect(mapped.S0?.hub).toBe(65);
    expect(unmapped.S9?.hub).toBe(65);
    const joined = resistHubPeople({ ...unmapped, ...mapped });
    expect(nearMissRate(joined, speakers, 'hub')).toBe(0);
    expect(joined.S0?.meet).toBe(20);
  });

  it('drops the hub on the speaker-level scores the meeting actually uses', () => {
    const own = speakers.map((speaker, i) => ({ speaker, start: i * 10 + 1, end: i * 10 + 9 }));
    for (const voiceprints of [flatHub, spreadHub, loneSpikes]) {
      const output: IdentifyOutputLike = {
        diarization: speakers.map((speaker, i) => ({ speaker, start: i * 10, end: i * 10 + 10 })),
        voiceprints,
      };
      const { matrix } = buildSpeakerLevelMatrix(own, output, map);
      expect(nearMissRate(matrix, speakers, 'hub')).toBe(0);
      expect(matrix.S9).toMatchObject({ meet: 88 });
    }
  });
});
