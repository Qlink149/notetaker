import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Anthropic SDK is replaced by a scripted fake: the tests look at what the summariser asks for and how it reacts.
const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status?: number;
  }
  class APIConnectionError extends APIError {}
  class Anthropic {
    messages = { create: (...a: unknown[]) => sdk.create(...a) };
    static APIError = APIError;
    static APIConnectionError = APIConnectionError;
  }
  return { default: Anthropic };
});

import { REQUIRED_SECTIONS, SECTION_NOT_PRODUCED, missingSections } from '@meetingid/pipeline';
import { resetEnvCache } from '../src/config/env.js';
import {
  ClaudeSummariser,
  MAX_SINGLE_CALL_CHARS,
  outputConfigFor,
  tokenLimit,
  type SummaryInput,
} from '../src/services/summary/claude.js';
import { FatalError } from '../src/pipeline/errors.js';

beforeEach(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://localhost:1/unused',
    JWT_SECRET: 'x'.repeat(40),
    ANTHROPIC_API_KEY: 'test-anthropic',
  });
  resetEnvCache();
  sdk.create.mockReset();
});

const lines = [
  {
    start: 1,
    end: 5,
    speakerName: 'Yogansh',
    textRoman: 'kal ka task list likh de',
    textNative: '',
  },
  { start: 6, end: 9, speakerName: 'Laksh', textRoman: 'diary le ke aata hoon', textNative: '' },
] as unknown as SummaryInput['lines'];

const input = (model: string, over: Partial<SummaryInput> = {}): SummaryInput => ({
  lines,
  glossary: null,
  languages: ['hi', 'en'],
  includeNative: false,
  model,
  ...over,
});

const full = REQUIRED_SECTIONS.map((s) => `## ${s}\nbody ${s}`).join('\n\n');
const reply = (markdown: string, items: { speaker_name: string; text: string }[] = []) => ({
  content: [
    { type: 'text', text: JSON.stringify({ summary_markdown: markdown, action_items: items }) },
  ],
  usage: { input_tokens: 100, output_tokens: 50 },
  stop_reason: 'end_turn',
});
const notJson = () => ({
  content: [{ type: 'text', text: 'sorry, here you go' }],
  usage: { input_tokens: 100, output_tokens: 10 },
  stop_reason: 'end_turn',
});
const request = (n: number) =>
  sdk.create.mock.calls[n]![0] as {
    model: string;
    max_tokens: number;
    system: string;
    messages: { content: string }[];
    output_config?: { format?: unknown; effort?: string };
  };

describe('request settings per model', () => {
  it('Sonnet 5.5: medium effort, room for thinking, the JSON schema, and the new rules in the instructions', async () => {
    sdk.create.mockResolvedValueOnce(reply(full));
    await new ClaudeSummariser().summarise(input('claude-sonnet-5-5'));
    const r = request(0);
    expect(r.model).toBe('claude-sonnet-5-5');
    expect(r.max_tokens).toBe(16000);
    expect(r.output_config?.effort).toBe('medium');
    expect(r.output_config?.format).toMatchObject({ type: 'json_schema' });
    expect(r.system).toMatch(/All five headings are mandatory/);
    expect(r.system).toMatch(/Task lists: when a speaker dictates/);
  });

  it('Haiku: no effort setting (it would be rejected) and the original token limit', async () => {
    sdk.create.mockResolvedValueOnce(reply(full));
    await new ClaudeSummariser().summarise(input('claude-haiku-4-5'));
    const r = request(0);
    expect(r.max_tokens).toBe(8000);
    expect(r.output_config?.effort).toBeUndefined();
    expect(r.output_config?.format).toMatchObject({ type: 'json_schema' });
  });

  it('notes for a very long transcript use low effort and no schema; the final call still checks the sections', async () => {
    const long = Array.from({ length: Math.ceil(MAX_SINGLE_CALL_CHARS / 40) + 50 }, (_, i) => ({
      start: i,
      end: i + 1,
      speakerName: 'Yogansh',
      textRoman: 'a'.repeat(60),
      textNative: '',
    })) as unknown as SummaryInput['lines'];
    sdk.create.mockResolvedValue(reply(full));
    sdk.create.mockResolvedValueOnce({ ...reply(''), content: [{ type: 'text', text: '- note' }] });
    sdk.create.mockResolvedValueOnce({ ...reply(''), content: [{ type: 'text', text: '- note' }] });
    await new ClaudeSummariser().summarise(input('claude-sonnet-5-5', { lines: long }));
    const segment = request(0);
    expect(segment.output_config).toEqual({ effort: 'low' });
    expect(segment.max_tokens).toBe(8192);
    const final = sdk.create.mock.calls.at(-1)![0] as {
      output_config: { effort: string; format: unknown };
    };
    expect(final.output_config.effort).toBe('medium');
  });

  it('the helpers agree', () => {
    expect(tokenLimit('claude-haiku-4-5-20251001', 4096)).toBe(4096);
    expect(tokenLimit('claude-sonnet-5-5', 4096)).toBe(8192);
    expect(outputConfigFor('claude-haiku-4-5', false)).toEqual({});
  });
});

describe('a summary that leaves sections out', () => {
  it('asks again, naming the missing sections, and returns the complete answer', async () => {
    sdk.create
      .mockResolvedValueOnce(reply('## Overview\nx\n\n## Key Topics\n- a'))
      .mockResolvedValueOnce(reply(full, [{ speaker_name: 'Laksh', text: 'Bring the diary' }]));
    const out = await new ClaudeSummariser().summarise(input('claude-sonnet-5-5'));
    expect(sdk.create).toHaveBeenCalledTimes(2);
    const second = request(1).messages[0]!.content;
    expect(second).toContain('Reviewer note');
    expect(second).toContain('Decisions, Insights, Open Questions');
    expect(second.startsWith('Transcript:')).toBe(true);
    expect(out.result?.summaryMarkdown).toBe(full);
    expect(out.result?.actionItems).toEqual([{ speakerName: 'Laksh', text: 'Bring the diary' }]);
    expect(out.usage).toEqual({ inputTokens: 200, outputTokens: 100 }); // both calls are paid for
  });

  it('after three incomplete answers keeps the most complete one and says which sections were not produced', async () => {
    sdk.create
      .mockResolvedValueOnce(reply('## Overview\nx'))
      .mockResolvedValueOnce(reply('## Overview\nx\n\n## Key Topics\n- a\n\n## Insights\nNone.'))
      .mockResolvedValueOnce(reply('## Overview\nx\n\n## Key Topics\n- a'));
    const out = await new ClaudeSummariser().summarise(input('claude-sonnet-5-5'));
    expect(sdk.create).toHaveBeenCalledTimes(3);
    const md = out.result!.summaryMarkdown;
    expect(missingSections(md)).toEqual([]);
    expect(md).toContain('## Insights\nNone.'); // the best attempt's own text is kept
    expect(md).toContain(`## Decisions\n${SECTION_NOT_PRODUCED}`);
    expect(md).toContain(`## Open Questions\n${SECTION_NOT_PRODUCED}`);
    expect(out.usage.inputTokens).toBe(300);
  });

  it('keeps an earlier incomplete answer when a later attempt fails, and still reports what was paid', async () => {
    sdk.create
      .mockResolvedValueOnce(reply('## Overview\nx\n\n## Key Topics\n- a\n\n## Insights\nNone.'))
      .mockRejectedValueOnce(new Error('connection reset'));
    const out = await new ClaudeSummariser().summarise(input('claude-sonnet-5-5'));
    expect(sdk.create).toHaveBeenCalledTimes(2);
    expect(missingSections(out.result!.summaryMarkdown)).toEqual([]);
    expect(out.result!.summaryMarkdown).toContain(`## Decisions\n${SECTION_NOT_PRODUCED}`);
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('with nothing usable yet, a failing attempt throws but carries the usage already paid for', async () => {
    sdk.create
      .mockResolvedValueOnce(notJson())
      .mockRejectedValueOnce(new Error('connection reset'));
    const err = await new ClaudeSummariser().summarise(input('claude-sonnet-5-5')).then(
      () => null,
      (e: unknown) => e as Error & { usage?: unknown },
    );
    expect(err?.message).toBe('connection reset');
    expect(err?.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
  });

  it('when answers are equally incomplete the latest one is kept, since it was written after the reviewer note', async () => {
    sdk.create
      .mockResolvedValueOnce(reply('## Overview\nfirst'))
      .mockResolvedValueOnce(reply('## Overview\nsecond'))
      .mockResolvedValueOnce(reply('## Overview\nthird'));
    const out = await new ClaudeSummariser().summarise(input('claude-sonnet-5-5'));
    expect(out.result!.summaryMarkdown).toContain('third');
    expect(out.result!.summaryMarkdown).not.toContain('first');
  });

  it('a reply that is not valid JSON is also asked again, with the reason', async () => {
    sdk.create.mockResolvedValueOnce(notJson()).mockResolvedValueOnce(reply(full));
    const out = await new ClaudeSummariser().summarise(input('claude-sonnet-5-5'));
    expect(request(1).messages[0]!.content).toMatch(/Reviewer note.*invalid JSON/);
    expect(out.result?.summaryMarkdown).toBe(full);
  });

  it('gives up with an error when every attempt is unusable', async () => {
    sdk.create.mockResolvedValue(notJson());
    const out = await new ClaudeSummariser().summarise(input('claude-sonnet-5-5'));
    expect(out.result).toBeNull();
    expect(out.error).toMatch(/invalid JSON/);
    expect(sdk.create).toHaveBeenCalledTimes(3);
  });
});

describe('replies that are not a summary', () => {
  it('a refusal fails with its category, without another attempt', async () => {
    sdk.create.mockResolvedValue({
      content: [],
      usage: { input_tokens: 5, output_tokens: 0 },
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'general_harms' },
    });
    await expect(new ClaudeSummariser().summarise(input('claude-sonnet-5-5'))).rejects.toThrow(
      /declined the request \(general_harms\)/,
    );
    await expect(
      new ClaudeSummariser().summarise(input('claude-sonnet-5-5')),
    ).rejects.toBeInstanceOf(FatalError);
    expect(sdk.create).toHaveBeenCalledTimes(2);
  });

  it("a transcript beyond the model's context fails clearly", async () => {
    sdk.create.mockResolvedValue({
      content: [],
      usage: { input_tokens: 5, output_tokens: 0 },
      stop_reason: 'model_context_window_exceeded',
    });
    await expect(new ClaudeSummariser().summarise(input('claude-sonnet-5-5'))).rejects.toThrow(
      /too long for the summariser/,
    );
  });
});
