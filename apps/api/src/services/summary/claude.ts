import Anthropic from '@anthropic-ai/sdk';
import type { Glossary, Language, Line } from '@meetingid/shared';
import {
  chunkTranscript,
  formatLinesForSummary,
  parseSummary,
  renderGlossaryForPrompt,
  type ParsedSummary,
} from '@meetingid/pipeline';
import { requireEnv } from '../../config/env.js';
import { FatalError, RetryableError, errorForStatus } from '../../pipeline/errors.js';
import { LANGUAGE_NAMES } from '../engines/types.js';

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary_markdown: { type: 'string' },
    action_items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { speaker_name: { type: 'string' }, text: { type: 'string' } },
        required: ['speaker_name', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary_markdown', 'action_items'],
  additionalProperties: false,
} as const;

export interface SummaryUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface SummaryInput {
  lines: Line[];
  glossary: Glossary | null;
  languages: Language[];
  includeNative: boolean;
  model: string;
}

export interface Summariser {
  summarise(
    input: SummaryInput,
  ): Promise<{ result: ParsedSummary | null; usage: SummaryUsage; error?: string }>;
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY'), maxRetries: 2 });
  return client;
}

export function buildSummarySystemPrompt(
  input: Pick<SummaryInput, 'glossary' | 'languages'>,
  speakers: string[],
): string {
  const langs =
    input.languages.map((l) => LANGUAGE_NAMES[l]).join(', ') || 'Hindi, Gujarati, English';
  const glossary = renderGlossaryForPrompt(input.glossary);
  return [
    'You are an expert meeting analyst. You receive a transcript of a business meeting with labelled speakers.',
    `The meeting was held in ${langs}; the transcript is romanised (Latin script) and may mix languages. Write the summary in English.`,
    glossary ? `Spell these names and terms exactly as given: ${glossary}` : '',
    `Speakers in this transcript: ${speakers.join(', ')}. Use speaker names exactly as given. If a name is "Speaker 3", write "Speaker 3". Never infer, guess or add a real identity, role or title for any speaker.`,
    '',
    'Return one JSON object with two fields:',
    '- summary_markdown: a detailed, specific summary in Markdown with exactly these sections, in this order:',
    '  "## Overview" (2-3 sentences on purpose, participants by label, and context),',
    '  "## Key Topics" (bullets, each with 1-3 sentences of specifics: names, numbers, proposals),',
    '  "## Decisions" (bullets; if none, write "No explicit decisions were made."),',
    '  "## Insights" (notable points, risks, concerns),',
    '  "## Open Questions" (anything unresolved or flagged for follow-up).',
    '  Do not include action items, horizontal rules (---) or any other heading in summary_markdown. Never write an "ACTION_ITEMS" marker or heading anywhere; action items go only in the action_items field.',
    '- action_items: every task, follow-up, commitment or next step. text is an imperative phrase starting with a verb, including any deadline, dependency or context stated. speaker_name is the speaker who owns it, exactly as labelled; if the owner is unclear use "Unassigned". Deduplicate near-identical items.',
    'Base everything strictly on the transcript. Do not invent facts.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

const textOf = (msg: Anthropic.Message): string =>
  msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');

function mapError(err: unknown): Error {
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    return errorForStatus('anthropic', err.status, err.message);
  }
  if (err instanceof Anthropic.APIConnectionError)
    return new RetryableError(err.message, 'network');
  return err instanceof Error ? err : new Error(String(err));
}

/** Claude Haiku 4.5 summariser: one structured JSON call, chunked + merged for very long transcripts. */
export class ClaudeSummariser implements Summariser {
  async summarise(input: SummaryInput) {
    const usage: SummaryUsage = { inputTokens: 0, outputTokens: 0 };
    const speakers = [...new Set(input.lines.map((l) => l.speakerName))];
    const transcript = formatLinesForSummary(input.lines, { includeNative: input.includeNative });
    const parts = chunkTranscript(transcript, 60_000);

    const call = async (system: string, content: string, maxTokens: number, json: boolean) => {
      try {
        const msg = await anthropic().messages.create({
          model: input.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content }],
          ...(json
            ? {
                output_config: { format: { type: 'json_schema' as const, schema: SUMMARY_SCHEMA } },
              }
            : {}),
        });
        usage.inputTokens += msg.usage.input_tokens;
        usage.outputTokens += msg.usage.output_tokens;
        if (msg.stop_reason === 'max_tokens')
          throw new RetryableError('summary truncated at max_tokens', 'truncated');
        if (msg.stop_reason === 'refusal') throw new FatalError('summariser declined the request');
        return textOf(msg);
      } catch (err) {
        throw mapError(err);
      }
    };

    // Very long meetings: summarise each part first, then summarise the part summaries.
    let body: string;
    if (parts.length === 1) {
      body = `Transcript:\n${parts[0]}`;
    } else {
      const partSummaries: string[] = [];
      for (const [i, part] of parts.entries()) {
        const s = await call(
          'Summarise this meeting transcript segment in 5-10 Markdown bullets. Be specific about topics, names, numbers, decisions and tasks with their owners (speaker labels exactly as written).',
          part,
          2048,
          false,
        );
        partSummaries.push(`Segment ${i + 1}:\n${s}`);
      }
      body = `The transcript was too long to send at once. Summaries of consecutive segments:\n\n${partSummaries.join('\n\n')}`;
    }

    const system = buildSummarySystemPrompt(input, speakers);
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await call(system, body, 8000, true);
      const parsed = parseSummary(text, [...speakers, 'Unassigned']);
      if (parsed.ok) return { result: parsed.value, usage };
      lastError = parsed.error;
    }
    return { result: null, usage, error: lastError };
  }
}
