import { describe, expect, it } from 'vitest';
import {
  REQUIRED_SECTIONS,
  SECTION_NOT_PRODUCED,
  missingSections,
  repairSections,
} from '../src/summaryParse.js';

const full = REQUIRED_SECTIONS.map((s) => `## ${s}\nbody`).join('\n\n');

describe('required summary sections', () => {
  it('finds nothing missing in a complete summary', () => {
    expect(missingSections(full)).toEqual([]);
  });

  it('names exactly the sections that are absent', () => {
    expect(missingSections('## Overview\nx\n\n## Key Topics\n- a')).toEqual([
      'Decisions',
      'Insights',
      'Open Questions',
    ]);
    expect(missingSections('')).toEqual([...REQUIRED_SECTIONS]);
  });

  it('accepts harmless variations in the heading', () => {
    const md = [
      '# Overview',
      '### key topics:',
      '## 3. Decisions',
      '## **Insights**',
      '## Open questions',
    ].join('\ntext\n');
    expect(missingSections(md)).toEqual([]);
  });

  it('accepts a heading with a remark after it, and underscore emphasis', () => {
    const md = [
      '## Overview',
      '## Key Topics',
      '## Decisions (none)',
      '## Insights: none',
      '## _Open Questions_',
    ].join('\ntext\n');
    expect(missingSections(md)).toEqual([]);
    expect(repairSections(md)).toBe(md); // no duplicate placeholder under a heading that was there
  });

  it('reads Windows line endings', () => {
    const md = REQUIRED_SECTIONS.map((s) => `## ${s}\r\nbody`).join('\r\n\r\n');
    expect(missingSections(md)).toEqual([]);
  });

  it('does not count a heading that only appears inside a code block', () => {
    const md =
      '## Overview\n## Key Topics\n```\n## Decisions\n## Insights\n## Open Questions\n```\n';
    expect(missingSections(md)).toEqual(['Decisions', 'Insights', 'Open Questions']);
  });

  it('does not count the words in running text or a different heading', () => {
    expect(missingSections('Overview of decisions and insights\n## Decisions made later')).toEqual([
      ...REQUIRED_SECTIONS,
    ]);
  });

  it('adds only the missing sections, with an honest line, and leaves the rest as written', () => {
    const md = '## Overview\nOK\n\n## Key Topics\n- a\n\n## Insights\nNone.';
    const fixed = repairSections(md);
    expect(fixed.startsWith(md)).toBe(true);
    expect(missingSections(fixed)).toEqual([]);
    expect(fixed).toContain(`## Decisions\n${SECTION_NOT_PRODUCED}`);
    expect(fixed).toContain(`## Open Questions\n${SECTION_NOT_PRODUCED}`);
    expect((fixed.match(/## Insights/g) ?? []).length).toBe(1);
  });

  it('leaves a complete summary untouched', () => {
    expect(repairSections(full)).toBe(full);
  });
});
