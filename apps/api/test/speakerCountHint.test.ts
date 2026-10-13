import { describe, expect, it } from 'vitest';
import { speakerCountHint } from '../src/services/pyannote/client.js';

describe('speakerCountHint', () => {
  it('gives pyannote a tight range around the number of people given', () => {
    expect(speakerCountHint(3)).toEqual({ minSpeakers: 2, maxSpeakers: 4 });
    expect(speakerCountHint(1)).toEqual({ minSpeakers: 1, maxSpeakers: 2 });
    expect(speakerCountHint(50)).toEqual({ minSpeakers: 49, maxSpeakers: 51 });
  });
  it('gives nothing without a usable count, so pyannote decides alone', () => {
    expect(speakerCountHint(null)).toEqual({});
    expect(speakerCountHint(undefined)).toEqual({});
    expect(speakerCountHint(0)).toEqual({});
  });
});
