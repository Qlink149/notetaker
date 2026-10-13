import { describe, expect, it } from 'vitest';
import type { DiarSegment, DiarizationOutput } from '../src/diarization.js';
import { applySpeakerMerges, mergeConfusableSpeakers } from '../src/mergeSpeakers.js';

// A = a long, clearly separate voice. B and D are one person split in two: each hears the other.
const seg = (speaker: string, start: number, end: number, confidence: Record<string, number>): DiarSegment => ({
  speaker, start, end, confidence,
});
const A = { A: 90, B: 16, D: 16, H: 16 };
const B = { A: 16, B: 89, D: 87, H: 38 };
// D's segments are heard as B: close to B in about half of them, within ten points in all of them
const D = { A: 17, B: 79, D: 81, H: 27 };
const D2 = { A: 17, B: 73, D: 81, H: 27 };
const H = { A: 16, B: 40, D: 33, H: 88 };

function meeting(extra: DiarSegment[] = []): DiarizationOutput {
  const diarization: DiarSegment[] = [
    seg('A', 0, 60, A), seg('B', 60, 100, B), seg('H', 100, 130, H),
    seg('D', 130, 140, D), seg('A', 140, 200, A), seg('B', 200, 230, B), seg('D', 230, 240, D2),
    ...extra,
  ];
  return { diarization, exclusiveDiarization: diarization.map(({ confidence: _c, ...s }) => s) };
}

describe('mergeConfusableSpeakers', () => {
  it('merges a voice that pyannote split in two, and nothing else', () => {
    const { output, merges } = mergeConfusableSpeakers(meeting());
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ from: 'D', into: 'B' }); // the shorter label goes into the longer
    expect(new Set(output.diarization.map((s) => s.speaker))).toEqual(new Set(['A', 'B', 'H']));
    // the exclusive diarization (no confidences of its own) is relabelled the same way
    expect(new Set((output.exclusiveDiarization ?? []).map((s) => s.speaker))).toEqual(new Set(['A', 'B', 'H']));
    // confidences of the merged label are folded into the survivor
    expect(output.diarization.every((s) => !('D' in (s.confidence ?? {})))).toBe(true);
  });

  it('applies a stored decision later and gets exactly the same speakers as measuring did', () => {
    const input = meeting();
    const decided = mergeConfusableSpeakers(input);
    expect(applySpeakerMerges(input, decided.merges)).toEqual(decided.output);
    expect(applySpeakerMerges(input, [])).toBe(input);
  });

  it('does not change its input', () => {
    const input = meeting();
    const copy = JSON.stringify(input);
    mergeConfusableSpeakers(input);
    expect(JSON.stringify(input)).toBe(copy);
  });

  it('keeps two voices that talk at the same time, however alike they sound', () => {
    // D speaks over B for 10 of its 20 seconds: one person cannot do that
    const input = meeting([seg('B', 300, 310, B), seg('D', 300, 310, D)]);
    const { merges } = mergeConfusableSpeakers(input);
    expect(merges).toEqual([]);
  });

  it('keeps voices that only one direction finds alike (a quiet voice next to a loud one)', () => {
    const quiet = { A: 16, B: 79, D: 80, H: 16 }; // D'-like segments score B high, but B segments never score D
    const diarization = [seg('B', 0, 100, { A: 16, B: 90, D: 20, H: 16 }), seg('D', 100, 130, quiet), seg('A', 130, 230, A)];
    expect(mergeConfusableSpeakers({ diarization }).merges).toEqual([]);
  });

  it('keeps two people who sound alike in one direction only and are not within five points (AOM: Sheetal and Parag)', () => {
    // 03 is heard as 04 almost all the time, 04 is heard as 03 less often, and neither comes within five points
    const diarization = [
      seg('X', 0, 100, { X: 92, P: 16, Q: 86 }), seg('Q', 100, 130, { X: 80, P: 16, Q: 89 }),
      seg('Q', 130, 200, { X: 78, P: 16, Q: 89 }), seg('X', 200, 260, { X: 92, P: 16, Q: 84 }),
      seg('P', 260, 360, { X: 16, P: 90, Q: 16 }),
    ];
    expect(mergeConfusableSpeakers({ diarization }).merges).toEqual([]);
  });

  it('leaves very short labels alone', () => {
    const diarization = [seg('B', 0, 100, B), seg('D', 100, 102, D), seg('A', 102, 200, A)];
    expect(mergeConfusableSpeakers({ diarization }).merges).toEqual([]);
  });

  it('does nothing when the output has no confidences', () => {
    const diarization: DiarSegment[] = [
      { speaker: 'A', start: 0, end: 50 }, { speaker: 'B', start: 50, end: 100 }, { speaker: 'D', start: 100, end: 150 },
    ];
    const input: DiarizationOutput = { diarization };
    expect(mergeConfusableSpeakers(input)).toEqual({ output: input, merges: [] });
  });

  it('can merge three fragments of one voice into one', () => {
    const f = (x: string): Record<string, number> => ({ A: 16, B: x === 'B' ? 89 : 86, D: x === 'D' ? 89 : 86, E: x === 'E' ? 89 : 86 });
    const diarization = [seg('A', 0, 100, { A: 90, B: 16, D: 16, E: 16 }), seg('B', 100, 160, f('B')), seg('D', 160, 190, f('D')), seg('E', 190, 215, f('E'))];
    const { output, merges } = mergeConfusableSpeakers({ diarization });
    expect(merges).toHaveLength(2);
    expect(new Set(output.diarization.map((s) => s.speaker))).toEqual(new Set(['A', 'B']));
  });
});
