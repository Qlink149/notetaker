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

/** Transcripts up to this size are summarised in one call: splitting loses detail, and a 2-hour meeting is about 130,000 characters. */
export const MAX_SINGLE_CALL_CHARS = 250_000;

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
  /** Used by the handoff summariser to key its request. */
  meetingId?: string;
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
    `Speakers in this transcript: ${speakers.join(', ')}. Use these names exactly as given, and only these: never invent labels such as "Speaker C", never call one person by two names. If a name is "Speaker 3", write "Speaker 3". Never infer, guess or add a real identity, role or title for any speaker, and never guess anyone's gender: use names, or "they".`,
    '',
    'Accuracy rules (they matter more than anything else):',
    '- Base everything strictly on what participants said. Do not add inferences, risks, motives, background or conclusions of your own (about people, ages, succession, competition, returns). When unsure, leave it out.',
    '- Say who said, proposed, offered or objected, using the speaker names. One person\'s advice, suggestion or argument is that person\'s view ("Ravi advised..."), not the group\'s. For an argument, check its direction: say whether the speaker is for or against, and why.',
    '- What a speaker reports about a third party ("he said", "they asked for", "the franchisee told me") belongs to that third party, not to the speaker. When a speaker scripts or role-plays what someone else should say ("sir, we will plan three months and I will stay three days"), report it as guidance for that role, never as the speaker\'s own commitment. When the transcript does not make clear who said or offered something, say so ("one of the firms") instead of guessing.',
    '- Tie each figure, activity and brand to the entity the speaker tied it to (the client, a separate business of the speaker, a competitor, a third party). Do not move it to another entity.',
    '- Report the final position: when a speaker corrects a figure, retracts or concedes, use the corrected or final version. When speakers disagree, or the discussion ends without settling, give both views and say it was not settled. Do not call figures "not reconciled", "unsettled" or "contradictory" unless the speakers themselves pointed out a conflict: a figure worked out from another one (325 plus 40% is about 550), a self-correction, two figures that measure different things, and a question like "what is 1800 crore in millions?" (a conversion, not a correction) are not conflicts. Give the derivation or the corrected figure.',
    '- "Let\'s say", "suppose", "samajho", "maan lo", "jaise", "for example", "just a thought" are illustrations, not facts, targets or commitments: present them as such or leave them out. Do not link two facts by cause or sequence unless a speaker did.',
    '- A labelled line can contain another participant\'s words, or a sentence can be split across two labels. If a line clearly conflicts with its context, describe it neutrally and do not build a point on the label.',
    '- Read Hindi and Gujarati correctly: "N tareekh tak" means until the Nth (a date, not N days); saath = 60, dhai = 2.5, do-chaar = 2 to 4, "baso baso" = 200 each; "taka" = percent; "X% ja raha hai" means it costs X%; nafo = profit, nuksaan = loss; karod = crore; "bhai", "ji", "sir" are honorifics, not part of a role.',
    '',
    'Money and numbers:',
    '- Write every amount with the currency and unit exactly as spoken ($ or dollars, rupees or ₹, lakh, crore, million, billion, %). Never convert between currencies and never assume one: an Indian company does not mean rupees, and "1 million" next to dollars stays dollars, illustrations included. A bare number stays bare: do not add a currency the speaker did not say. If speakers give both ("₹10 lakh, that is $10,000"), keep both.',
    '- Say what a number measures: per store or in total, per month or per year, fixed or variable, cost or benefit. Keep ranges as ranges and keep tentative figures tentative.',
    '- Only state numbers, counts and dates that are in the transcript. Do not work out new totals. A bare day number ("the 23rd") gets no month unless a speaker said one. Do not report a figure that cannot be right (a discount larger than the sale): check how the speaker corrected it.',
    '',
    'Return one JSON object with two fields:',
    '- summary_markdown: a detailed, specific summary in Markdown with exactly these sections, in this order:',
    '  "## Overview" (2-4 sentences: the purpose of the meeting, the organisations and brands named, who took part by name, the context),',
    '  "## Key Topics" (bullets in the order discussed. Cover every substantial topic, including numbers with their currency and unit, who said them, and each speaker\'s main proposal even if it was not accepted. Include explicit instructions from senior participants and who accepted them. Group related details into one bullet of one to three sentences, about 25 bullets at most, and skip fragments that carry no meaning),',
    '  "## Decisions" (what participants explicitly decided or agreed: a confirmed date, place, price or plan, a plan or date that a second participant confirmed ("barabar", "haan, theek hai"), including near the end of the meeting, and an option that was ruled out. Not advice, not a proposal still awaiting approval, not "should" statements without an amount, date or plan, not a spelling correction, and not something someone objected to or left to "think about". If there are none, write "No explicit decisions were made."),',
    '  "## Insights" (at most five short bullets: a risk, concern or opinion that a participant actually raised and that is not already stated in Key Topics, attributed to that person as their view. If there is none, write "None beyond the topics above."),',
    '  "## Open Questions" (only questions that participants asked and left unanswered, or issues they said remain open. Not a target, an uncertain figure or a doubt of your own turned into a question; not a question that was answered in the meeting; not a request that was accepted).',
    '  Say each point once, in the section where it fits best. Do not include action items, horizontal rules (---) or any other heading in summary_markdown. Never write an "ACTION_ITEMS" marker or heading anywhere; action items go only in the action_items field.',
    '- action_items: a task that a person commits to, accepts, or is explicitly asked to do in the meeting. This includes a first-person promise ("I will check", "main check kar deta hoon", "kahi daish", "nikaal dunga"), a plain instruction to a named person or group ("Venky, follow up", "make the plan") and an instruction that the person addressed accepted ("bilkul", "haan"). text is an imperative phrase starting with a verb, including any deadline, dependency or context stated. speaker_name is the person who committed or was asked, or the named group, exactly as labelled: never the person who gave the instruction, never a speaker who only advised, and never "Unassigned" when the person addressed or the group is named. If the person is not one of the speakers, use "Unassigned" and put the person\'s name in the text. Do not turn advice, "we could / should" statements, proposals awaiting approval, ideas, role-played scripts, hypotheticals, risks or open questions into tasks, and do not invent follow-up or verification tasks. Deduplicate near-identical items. If the meeting contains no real action items, return an empty list.',
    'Base everything strictly on the transcript. Do not invent facts.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** One part of a transcript that is too long to send whole: notes that are merged into the final summary. */
export const SEGMENT_PROMPT = [
  'Make faithful notes of this part of a longer meeting transcript. The notes will be merged with the notes of the other parts into the final summary, so nothing may be lost or changed.',
  'Write 15-30 Markdown bullets in the order of the discussion. Keep every number together with its currency and unit exactly as spoken ($ or dollars, rupees, lakh, crore, million, %), what it measures, and who said it. Never convert or assume a currency, and keep a bare number bare.',
  'Record who proposed, offered, objected, agreed or conceded (speaker names exactly as written), what was explicitly decided, and any task a person committed to or was asked to do, with its owner. Mark advice, ideas, hypotheticals and role-played scripts as such. What a speaker reports about a third party belongs to that third party. When a figure is corrected later in this part, give the corrected one.',
  'Do not interpret, do not infer, do not guess anyone\'s gender, and do not add anything that was not said.',
].join('\n');

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
    const parts = chunkTranscript(transcript, MAX_SINGLE_CALL_CHARS);

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
          SEGMENT_PROMPT,
          part,
          4096,
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
