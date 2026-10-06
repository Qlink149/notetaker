import { describe, expect, it } from 'vitest';
import { UNASSIGNED, parseSummary } from '../src/summaryParse.js';

const body = {
  summary_markdown: '## Overview\nSales review.\n\n## Decisions\n- Expand in Gujarat.',
  action_items: [{ speaker_name: 'Speaker 1', text: 'Send the report by Friday.' }],
};

describe('parseSummary', () => {
  it('parses unfenced JSON', () => {
    const r = parseSummary(JSON.stringify(body));
    expect(r).toEqual({
      ok: true,
      value: {
        summaryMarkdown: body.summary_markdown,
        actionItems: [{ speakerName: 'Speaker 1', text: 'Send the report by Friday.' }],
      },
    });
  });

  it('parses JSON inside a ```json fence with surrounding prose', () => {
    const r = parseSummary('Here you go:\n```json\n' + JSON.stringify(body) + '\n```\nThanks');
    expect(r.ok).toBe(true);
  });

  it('rejects broken JSON', () => {
    const r = parseSummary('{"summary_markdown": "## Overview", "action_items": [');
    expect(r.ok).toBe(false);
  });

  it('rejects JSON with the wrong shape', () => {
    expect(parseSummary(JSON.stringify({ summary: 'x', action_items: [] })).ok).toBe(false);
    expect(parseSummary('').ok).toBe(false);
  });

  it('strips stray --- rules and ACTION_ITEMS headings from the markdown', () => {
    const r = parseSummary(
      JSON.stringify({
        ...body,
        summary_markdown: '## Overview\nx\n\n---\n\n## ACTION_ITEMS\n- y',
      }),
    );
    expect(r.ok && r.value.summaryMarkdown).toBe('## Overview\nx\n\n- y');
  });

  it('never keeps an inferred identity for an action-item owner', () => {
    const r = parseSummary(
      JSON.stringify({
        summary_markdown: '## Overview\nx',
        action_items: [
          { speaker_name: 'Speaker 1 (Meeting Facilitator/Shital)', text: 'Book the venue.' },
          { speaker_name: 'Shital', text: 'Call the vendor.' },
          { speaker_name: 'Speaker 2', text: 'Call the vendor.' },
        ],
      }),
      ['Speaker 1', 'Speaker 2'],
    );
    expect(r.ok && r.value.actionItems).toEqual([
      { speakerName: 'Speaker 1', text: 'Book the venue.' },
      { speakerName: UNASSIGNED, text: 'Call the vendor.' },
    ]);
  });
});
