import { describe, expect, it } from 'vitest';
import { trimOutput } from '../src/services/pyannote/output.js';

describe('trimOutput', () => {
  it('drops the frame-level confidence curve and keeps everything the app reads', () => {
    const out = {
      diarization: [{ start: 0, end: 1, speaker: 'SPEAKER_00', confidence: { SPEAKER_00: 90 } }],
      exclusiveDiarization: [{ start: 0, end: 1, speaker: 'SPEAKER_00' }],
      identification: [{ start: 0, end: 1, confidence: { a: 50 } }],
      voiceprints: [{ speaker: 'SPEAKER_00', match: 'a', confidence: { a: 50 } }],
      confidence: { resolution: 0.0167, score: new Array(1000).fill(90) },
    };
    const kept = trimOutput(out);
    expect('confidence' in kept).toBe(false);
    expect(kept.diarization[0]!.confidence).toEqual({ SPEAKER_00: 90 }); // per-segment scores stay
    expect(kept.voiceprints).toEqual(out.voiceprints);
    expect(kept.exclusiveDiarization).toEqual(out.exclusiveDiarization);
    expect(out.confidence).toBeDefined(); // the input is not modified
  });
  it('returns outputs without a curve, and non-objects, unchanged', () => {
    const a = { diarization: [] };
    expect(trimOutput(a)).toBe(a);
    expect(trimOutput(null)).toBeNull();
    expect(trimOutput('x')).toBe('x');
  });
});
