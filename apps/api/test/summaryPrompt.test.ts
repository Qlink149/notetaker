import { describe, expect, it } from 'vitest';
import {
  buildSummarySystemPrompt,
  MAX_SINGLE_CALL_CHARS,
  SEGMENT_PROMPT,
} from '../src/services/summary/claude.js';

// The summary prompt was rewritten after six real meetings were audited word by word against their
// transcripts (docs/SPEAKER_ISSUES.md, docs/SUMMARY_AUDIT.md). These tests keep the rules that fixed the
// recurring mistakes from being edited out by accident.
const prompt = buildSummarySystemPrompt(
  { glossary: null, languages: ['hi', 'gu', 'en'] },
  ['Ghanshyam Dholakia', 'Charles', 'Heet'],
);

describe('summary prompt', () => {
  it('lists the speakers and forbids invented labels and guessed gender', () => {
    expect(prompt).toContain('Speakers in this transcript: Ghanshyam Dholakia, Charles, Heet.');
    expect(prompt).toMatch(/never invent labels such as "Speaker C"/);
    expect(prompt).toMatch(/never guess anyone's gender/);
  });

  it('keeps the currency exactly as spoken and never assumes rupees', () => {
    expect(prompt).toMatch(/Never convert between currencies and never assume one/);
    expect(prompt).toMatch(/an Indian company does not mean rupees/);
    expect(prompt).toMatch(/A bare number stays bare/);
  });

  it('keeps advice, proposals and scripts out of Decisions and action items', () => {
    expect(prompt).toMatch(/Not advice, not a proposal still awaiting approval/);
    expect(prompt).toMatch(/never the person who gave the instruction/);
    expect(prompt).toMatch(/role-played scripts/);
    expect(prompt).toMatch(/If the meeting contains no real action items, return an empty list/);
  });

  it('counts a first-person promise and an accepted instruction as action items', () => {
    expect(prompt).toMatch(/"kahi daish"/);
    expect(prompt).toMatch(/accepted \("bilkul", "haan"\)/);
  });

  it('does not invent conflicts, insights or open questions', () => {
    expect(prompt).toMatch(/Do not call figures "not reconciled"/);
    expect(prompt).toMatch(/at most five short bullets/);
    expect(prompt).toMatch(/Not a target, an uncertain figure or a doubt of your own turned into a question/);
  });

  it('reads the Hindi and Gujarati words that were misread in the audits', () => {
    expect(prompt).toMatch(/"N tareekh tak" means until the Nth/);
    expect(prompt).toMatch(/saath = 60/);
    expect(prompt).toMatch(/"X% ja raha hai" means it costs X%/);
  });

  it('keeps the response format the parser expects', () => {
    expect(prompt).toContain('summary_markdown');
    expect(prompt).toContain('action_items');
    for (const h of ['## Overview', '## Key Topics', '## Decisions', '## Insights', '## Open Questions'])
      expect(prompt).toContain(h);
  });
});

describe('long transcripts', () => {
  it('are sent whole up to about two hours of speech, instead of being split and merged', () => {
    // a 73-minute meeting is about 80,000 characters
    expect(MAX_SINGLE_CALL_CHARS).toBeGreaterThanOrEqual(250_000);
  });

  it('are noted part by part without losing figures, owners or the corrected values', () => {
    expect(SEGMENT_PROMPT).toMatch(/currency and unit/);
    expect(SEGMENT_PROMPT).toMatch(/keep a bare number bare/);
    expect(SEGMENT_PROMPT).toMatch(/third party belongs to that third party/);
    expect(SEGMENT_PROMPT).toMatch(/corrected one/);
  });
});
