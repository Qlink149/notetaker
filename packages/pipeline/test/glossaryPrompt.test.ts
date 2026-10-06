import { describe, expect, it } from 'vitest';
import { glossaryKeyterms, renderGlossaryForPrompt } from '../src/glossaryPrompt.js';
import type { Glossary } from '@meetingid/shared';

const glossary: Glossary = {
  entries: [
    { term: 'Tanishq', kind: 'competitor', aliases: [] },
    { term: 'Kisna', kind: 'company', aliases: ['Kisna Diamond & Gold'] },
    { term: 'Ghanshyam Dholakia', kind: 'person', aliases: [] },
    { term: 'CaratLane', kind: 'competitor', aliases: ['Carat Lane'] },
    { term: 'Heet Dholakia', kind: 'person', aliases: [] },
  ],
};

describe('renderGlossaryForPrompt', () => {
  it('groups by kind in a fixed order and lists aliases', () => {
    expect(renderGlossaryForPrompt(glossary)).toBe(
      'Company: Kisna (also: Kisna Diamond & Gold). People: Ghanshyam Dholakia; Heet Dholakia. ' +
        'Competitors: Tanishq; CaratLane (also: Carat Lane).',
    );
  });

  it('is empty for no glossary', () => {
    expect(renderGlossaryForPrompt(null)).toBe('');
    expect(renderGlossaryForPrompt({ entries: [] })).toBe('');
  });
});

describe('glossaryKeyterms', () => {
  it('lists canonical terms before aliases, de-duplicated and capped', () => {
    expect(glossaryKeyterms(glossary)).toEqual([
      'Tanishq',
      'Kisna',
      'Ghanshyam Dholakia',
      'CaratLane',
      'Heet Dholakia',
      'Kisna Diamond & Gold',
      'Carat Lane',
    ]);
    expect(glossaryKeyterms(glossary, 2)).toEqual(['Tanishq', 'Kisna']);
  });
});
