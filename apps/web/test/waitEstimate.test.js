import { describe, expect, it } from 'vitest';
import { waitEstimate } from '../src/lib/format';

describe('waitEstimate', () => {
  it('is up to 1.5 minutes per 10 minutes of recording, rounded up', () => {
    expect(waitEstimate(600)).toEqual({ recordingMin: 10, waitMin: 2 }); // 1.5 -> 2
    expect(waitEstimate(3810)).toEqual({ recordingMin: 64, waitMin: 10 });
    expect(waitEstimate(4440)).toEqual({ recordingMin: 74, waitMin: 12 });
    expect(waitEstimate(7200)).toEqual({ recordingMin: 120, waitMin: 18 });
  });

  it('never says less than a minute', () => {
    expect(waitEstimate(30)).toEqual({ recordingMin: 1, waitMin: 1 });
  });

  it('has nothing to say until the length is known', () => {
    expect(waitEstimate(null)).toBeNull();
    expect(waitEstimate(undefined)).toBeNull();
    expect(waitEstimate(0)).toBeNull();
  });
});
