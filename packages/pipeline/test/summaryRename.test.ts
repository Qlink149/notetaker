import { describe, expect, it } from 'vitest';
import { renameInSummary, type SummaryRenameInput } from '../src/index.js';

const SUMMARY = [
  '## Overview',
  'Speaker A walked Heet through the DV360 plan. **Speaker B** asked about the budget.',
  '',
  '## Key Topics',
  "- Speaker A's plan: YouTube and Hotstar. Speaker AB is not a speaker.",
  '- Heet wants a baseline.',
].join('\n');
const ITEMS = [
  { speakerName: 'Speaker A', text: 'Email Heet the plan.' },
  { speakerName: 'Heet', text: 'Share the agency list with Speaker A.' },
  { speakerName: 'Unassigned', text: 'Fix the date.' },
];
const base = (over: Partial<SummaryRenameInput> = {}): SummaryRenameInput => ({
  summary: SUMMARY,
  actionItems: ITEMS,
  from: { unknown: 'Unknown', S0: 'Speaker A', S1: 'Heet', S2: 'Speaker B' },
  to: { unknown: 'Unknown', S0: 'Speaker A', S1: 'Heet', S2: 'Speaker B' },
  spokenText: 'Heet bhai, plan dekho. Budget kitna hai?',
  ...over,
});

describe('renaming speakers inside an existing summary (client request, 20 Oct)', () => {
  it('changes nothing when no name changed', () => {
    const r = renameInSummary(base());
    expect(r.status).toBe('unchanged');
    expect(r.summary).toBe(SUMMARY);
  });

  it('puts the new name everywhere "Speaker A" was, and nowhere else', () => {
    const r = renameInSummary(
      base({ to: { unknown: 'Unknown', S0: 'Paresh Ecom', S1: 'Heet', S2: 'Speaker B' } }),
    );
    expect(r.status).toBe('updated');
    expect(r.summary).toContain('Paresh Ecom walked Heet through');
    expect(r.summary).toContain("Paresh Ecom's plan");
    // a longer label that merely starts the same is left alone
    expect(r.summary).toContain('Speaker AB is not a speaker');
    expect(r.summary).toContain('**Speaker B** asked');
    expect(r.actionItems).toEqual([
      { speakerName: 'Paresh Ecom', text: 'Email Heet the plan.' },
      { speakerName: 'Heet', text: 'Share the agency list with Paresh Ecom.' },
      { speakerName: 'Unassigned', text: 'Fix the date.' },
    ]);
    expect(r.renames).toEqual([{ from: 'Speaker A', to: 'Paresh Ecom' }]);
  });

  it('swaps two names correctly (A↔B), without one overwriting the other', () => {
    const r = renameInSummary(
      base({ to: { unknown: 'Unknown', S0: 'Speaker B', S1: 'Heet', S2: 'Speaker A' } }),
    );
    expect(r.status).toBe('updated');
    expect(r.summary).toContain('Speaker B walked Heet');
    expect(r.summary).toContain('**Speaker A** asked');
  });

  it('never cuts a longer name with a shorter one ("Ravi" inside "Ravi Shah")', () => {
    const r = renameInSummary({
      summary: 'Ravi Shah and Ravi agreed. Raviraj was absent.',
      actionItems: [],
      from: { S0: 'Ravi Shah', S1: 'Ravi' },
      to: { S0: 'Ravi Shah', S1: 'Ravi Patel' },
      spokenText: 'agreed',
    });
    expect(r.status).toBe('updated');
    expect(r.summary).toBe('Ravi Shah and Ravi Patel agreed. Raviraj was absent.');
  });

  it('completes a name ("Heet" → "Heet Dholakia") even though Heet is said in the meeting', () => {
    const r = renameInSummary(
      base({ to: { unknown: 'Unknown', S0: 'Speaker A', S1: 'Heet Dholakia', S2: 'Speaker B' } }),
    );
    expect(r.status).toBe('updated');
    expect(r.summary).toContain('walked Heet Dholakia through');
    expect(r.summary).toContain('- Heet Dholakia wants a baseline.');
    expect(r.actionItems[1]!.speakerName).toBe('Heet Dholakia');
  });

  it('asks for a new summary when a corrected name is also a person talked about in the meeting', () => {
    // the voice was wrongly "Heet"; Heet is also mentioned, so some "Heet" in the summary may be the real Heet
    const r = renameInSummary(
      base({ to: { unknown: 'Unknown', S0: 'Speaker A', S1: 'Parth', S2: 'Speaker B' } }),
    );
    expect(r.status).toBe('needs_refresh');
    expect(r.summary).toBe(SUMMARY); // text untouched
    // the owner field is structured, so it is still renamed
    expect(r.actionItems[1]!.speakerName).toBe('Parth');
    expect(r.reasons.join(' ')).toMatch(/mentioned in the conversation/);
  });

  it('asks for a new summary when two speakers were joined into one', () => {
    const r = renameInSummary(base({ to: { unknown: 'Unknown', S0: 'Speaker A', S1: 'Heet' } }));
    expect(r.status).toBe('needs_refresh');
    expect(r.reasons.join(' ')).toMatch(/joined/);
  });

  it('does not mind a joined speaker the summary never mentions', () => {
    const r = renameInSummary({
      summary: 'Heet spoke.',
      actionItems: [],
      from: { S0: 'Heet', S1: 'Speaker F' },
      to: { S0: 'Heet' },
      spokenText: '',
    });
    expect(r.status).toBe('unchanged');
  });

  it('asks for a new summary when a speaker was split in two', () => {
    const r = renameInSummary(base({ to: { ...base().to, 'S0~1': 'Speaker D' } }));
    expect(r.status).toBe('needs_refresh');
    expect(r.reasons.join(' ')).toMatch(/split/);
  });

  it('asks for a new summary when two voices end up with the same name', () => {
    const r = renameInSummary(
      base({ to: { unknown: 'Unknown', S0: 'Speaker B', S1: 'Heet', S2: 'Speaker B' } }),
    );
    expect(r.status).toBe('needs_refresh');
    expect(r.reasons.join(' ')).toMatch(/both "Speaker B"/);
  });

  it('keeps two voices of the same person (both already "Heet") as they are', () => {
    const r = renameInSummary({
      summary: 'Heet spoke.',
      actionItems: [],
      from: { S0: 'Heet', S1: 'Heet' },
      to: { S0: 'Heet', S1: 'Heet' },
      spokenText: 'Heet bhai',
    });
    expect(r.status).toBe('unchanged');
  });

  it('handles names with special characters and the Unknown speaker', () => {
    const r = renameInSummary({
      summary: 'Speaker C (Google) and Unknown spoke.',
      actionItems: [{ speakerName: 'Speaker C', text: 'Call back.' }],
      from: { unknown: 'Unknown', S0: 'Speaker C' },
      to: { unknown: 'Unknown', S0: 'Harshit (Google DV360)' },
      spokenText: '',
    });
    expect(r.status).toBe('updated');
    expect(r.summary).toBe('Harshit (Google DV360) (Google) and Unknown spoke.');
    expect(r.actionItems[0]!.speakerName).toBe('Harshit (Google DV360)');
  });
});
