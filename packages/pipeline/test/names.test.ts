import { describe, expect, it } from 'vitest';
import { foldName, pickVoiceprints, similarNames } from '../src/index.js';

describe('similarNames', () => {
  const existing = ['Ghanshyam Dholakia', 'Rajesh Patel', 'Kaka'];
  it('ignores case, spacing and punctuation', () => {
    expect(similarNames('ghanshyam  dholakia', existing)).toEqual(['Ghanshyam Dholakia']);
    expect(foldName('Dr. Raj-esh')).toBe('drrajesh');
  });
  it('allows two edits in longer names', () => {
    expect(similarNames('Ghanshyam Dholkia', existing)).toEqual(['Ghanshyam Dholakia']);
    expect(similarNames('Rajesh Pattel', existing)).toEqual(['Rajesh Patel']);
  });
  it('does not match short or different names', () => {
    expect(similarNames('Kaki', existing)).toEqual([]);
    expect(similarNames('Rakesh Shah', existing)).toEqual([]);
    expect(similarNames('', existing)).toEqual([]);
  });
});

describe('pickVoiceprints', () => {
  const vp = (personId: string, quality: number) => ({ personId, quality });
  it('takes every person’s best voiceprint before anyone’s second', () => {
    const picked = pickVoiceprints(
      [vp('a', 70), vp('a', 90), vp('b', 80), vp('b', 60), vp('c', 50)],
      4,
    );
    expect(picked.map((p) => `${p.personId}${p.quality}`)).toEqual(['a90', 'b80', 'c50', 'a70']);
  });
  it('returns everything when under the cap and nothing for no input', () => {
    expect(pickVoiceprints([vp('a', 1)], 50)).toHaveLength(1);
    expect(pickVoiceprints([], 50)).toEqual([]);
  });
});
