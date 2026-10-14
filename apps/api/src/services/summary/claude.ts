import Anthropic from '@anthropic-ai/sdk';
import type { Glossary, Language, Line } from '@meetingid/shared';
import {
  chunkTranscript,
  formatLinesForSummary,
  missingSections,
  parseSummary,
  renderGlossaryForPrompt,
  repairSections,
  type ParsedSummary,
} from '@meetingid/pipeline';
import { requireEnv } from '../../config/env.js';
import { FatalError, RetryableError, errorForStatus } from '../../pipeline/errors.js';
import { LANGUAGE_NAMES } from '../engines/types.js';
import {
  MAX_SUMMARY_ATTEMPTS,
  SUMMARY_MAX_OUTPUT_TOKENS,
  supportsEffort,
  tokenLimit,
} from './limits.js';

export { MAX_SUMMARY_ATTEMPTS, tokenLimit };

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
    "- Say who said, proposed, offered or objected, using the speaker names. One person's advice, suggestion or argument is that person's view (\"Ravi advised...\"), not the group's. For an argument, check its direction: say whether the speaker is for or against, and why.",
    '- What a speaker reports about a third party ("he said", "they asked for", "the franchisee told me") belongs to that third party, not to the speaker. When a speaker scripts or role-plays what someone else should say ("sir, we will plan three months and I will stay three days"), report it as guidance for that role, never as the speaker\'s own commitment. When the transcript does not make clear who said or offered something, say so ("one of the firms") instead of guessing.',
    '- Tie each figure, activity and brand to the entity the speaker tied it to (the client, a separate business of the speaker, a competitor, a third party). Do not move it to another entity.',
    '- Report the final position: when a speaker corrects a figure, retracts or concedes, use the corrected or final version. When speakers disagree, or the discussion ends without settling, give both views and say it was not settled. Do not call figures "not reconciled", "unsettled" or "contradictory" unless the speakers themselves pointed out a conflict: a figure worked out from another one (325 plus 40% is about 550), a self-correction, two figures that measure different things, and a question like "what is 1800 crore in millions?" (a conversion, not a correction) are not conflicts. Give the derivation or the corrected figure.',
    '- "Let\'s say", "suppose", "samajho", "maan lo", "jaise", "for example", "just a thought" are illustrations, not facts, targets or commitments: present them as such or leave them out. Do not link two facts by cause or sequence unless a speaker did.',
    "- A labelled line can contain another participant's words, or a sentence can be split across two labels. If a line clearly conflicts with its context, describe it neutrally and do not build a point on the label.",
    '- Report what was said, not what followed from it: do not add a result, reason, deadline, role ("client", "vendor", "project") or outcome ("will make the call") that no speaker stated. A first name and a surname said on consecutive lines may be one person (a list of people to add: "Nikhil", then "Popli"): check later mentions before listing two.',
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
    '  "## Key Topics" (bullets in the order discussed: what was discussed, with the facts and figures, their currency and unit, who said them, and each speaker\'s main proposal even if it was not accepted. Include explicit instructions from senior participants and who accepted them. Leave the advice, opinions and warnings that speakers gave to Insights. Group related details into one bullet of one to three sentences, about 25 bullets at most, and skip fragments that carry no meaning),',
    '  "## Decisions" (what participants explicitly decided or agreed: a confirmed date, place, price or plan, a plan or date that a second participant confirmed ("barabar", "haan, theek hai"), including near the end of the meeting, and an option that was ruled out. Not advice, not a proposal still awaiting approval, not "should" statements without an amount, date or plan, not a spelling correction, and not something someone objected to or left to "think about". If there are none, write "No explicit decisions were made."),',
    '  "## Insights" (up to six short bullets with the main takeaways: the advice, opinions, warnings, risks and concerns that participants expressed, each attributed to the person who said it as their view, such as "Ravi warned that...". Before writing Insights, read your Key Topics: an Insights bullet must not repeat a Key Topics bullet in other words, so give only what is not already there. If nobody gave any, or all of it is already in Key Topics, write "None."),',
    '  "## Open Questions" (only questions that participants asked and left unanswered, or issues they said remain open. Not a target, an uncertain figure or a doubt of your own turned into a question; not a question that was answered in the meeting, even partly or in words the transcript garbled (read the lines that follow before listing a question); not a request that was accepted. If there are none, write "None.").',
    '  All five headings are mandatory: write every one of them, in this order, in every answer, even when a section has little to say (use the line given for it). A summary that stops after Key Topics is wrong.',
    '  Say each point once, in the section where it fits best. Do not include action items, horizontal rules (---) or any other heading in summary_markdown. Never write an "ACTION_ITEMS" marker or heading anywhere; action items go only in the action_items field.',
    '- action_items: a task that a person commits to, accepts, or is explicitly asked to do in the meeting. This includes a first-person promise ("I will check", "main check kar deta hoon", "kahi daish", "nikaal dunga"), a plain instruction to a named person or group ("Venky, follow up", "make the plan") and an instruction that the person addressed accepted ("bilkul", "haan"). text is an imperative phrase starting with a verb, including any deadline, dependency or context stated. speaker_name is the person who committed or was asked, or the named group, exactly as labelled: never the person who gave the instruction, never a speaker who only advised, and never "Unassigned" when the person addressed or the group is named. If the person is not one of the speakers, use "Unassigned" and put the person\'s name in the text. Do not turn advice, "we could / should" statements, proposals awaiting approval, ideas, role-played scripts, hypotheticals, risks or open questions into tasks, and do not invent follow-up or verification tasks. Task lists: when a speaker dictates or reads out entries for a task list, diary or message ("X ke liye likh de", "tera likh diya", "Yogansh to meet Sanjeet", "Lakshya, talk to Satish"), each entry is a task for the person it names, the one who will do the work, not for the person who writes it down or the one dictating. For "X to do Y" and "Y for X" the owner is X. "tera likh diya" means the entry is the work of the person addressed: the task is the work itself ("build the CBBA partner dashboard"), not "add it to the list". Writing something down is not itself a task. When a merged, garbled or unclear line leaves the owner open, use "Unassigned" and put the likely name in the text; never give a task to someone only because they were nearby. Deduplicate near-identical items. If the meeting contains no real action items, return an empty list.',
    'Base everything strictly on the transcript. Do not invent facts.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** One part of a transcript that is too long to send whole: notes that are merged into the final summary. */
export const SEGMENT_PROMPT = [
  'Make faithful notes of this part of a longer meeting transcript. The notes will be merged with the notes of the other parts into the final summary, so nothing may be lost or changed.',
  'Write 15-30 Markdown bullets in the order of the discussion. Keep every number together with its currency and unit exactly as spoken ($ or dollars, rupees, lakh, crore, million, %), what it measures, and who said it. Never convert or assume a currency, and keep a bare number bare.',
  'Record who proposed, offered, objected, agreed or conceded (speaker names exactly as written), what was explicitly decided, and any task a person committed to or was asked to do, with its owner. When entries are dictated for a task list or diary, the owner is the person the entry names, not the one who dictates or writes it down. Mark advice, ideas, hypotheticals and role-played scripts as such. What a speaker reports about a third party belongs to that third party. When a figure is corrected later in this part, give the corrected one.',
  "Do not interpret, do not infer, do not guess anyone's gender, and do not add anything that was not said.",
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

/**
 * The request's `output_config`: the JSON schema for the summary call, and a moderate thinking effort on models that
 * take one (extraction needs checking against the transcript, not deep reasoning; the notes for a long transcript need
 * even less).
 */
export function outputConfigFor(model: string, json: boolean) {
  const config = {
    ...(json ? { format: { type: 'json_schema' as const, schema: SUMMARY_SCHEMA } } : {}),
    ...(supportsEffort(model) ? { effort: (json ? 'medium' : 'low') as 'medium' | 'low' } : {}),
  };
  return Object.keys(config).length ? { output_config: config } : {};
}

/** What is added to the request after a rejected answer, so the next attempt knows what was wrong. */
export const retryNote = (problem: string): string =>
  `\n\n(Reviewer note: your previous answer was rejected: ${problem}. Return the complete JSON object again, with every section present in order.)`;

/** Claude summariser (Sonnet 5.5 by default): one structured JSON call, chunked and merged for very long transcripts. */
export class ClaudeSummariser implements Summariser {
  async summarise(input: SummaryInput) {
    const usage: SummaryUsage = { inputTokens: 0, outputTokens: 0 };
    try {
      return await this.run(input, usage);
    } catch (err) {
      // Whatever was already paid for travels with the failure, so the stage can still record the spend.
      if (err instanceof Error) Object.assign(err, { usage: { ...usage } });
      throw err;
    }
  }

  private async run(input: SummaryInput, usage: SummaryUsage) {
    const speakers = [...new Set(input.lines.map((l) => l.speakerName))];
    const transcript = formatLinesForSummary(input.lines, { includeNative: input.includeNative });
    const parts = chunkTranscript(transcript, MAX_SINGLE_CALL_CHARS);

    const call = async (system: string, content: string, maxTokens: number, json: boolean) => {
      try {
        const msg = await anthropic().messages.create({
          model: input.model,
          max_tokens: tokenLimit(input.model, maxTokens),
          system,
          messages: [{ role: 'user', content }],
          ...outputConfigFor(input.model, json),
        });
        usage.inputTokens += msg.usage.input_tokens;
        usage.outputTokens += msg.usage.output_tokens;
        if (msg.stop_reason === 'max_tokens')
          throw new RetryableError('summary truncated at max_tokens', 'truncated');
        if (msg.stop_reason === 'refusal') {
          const why = (msg as { stop_details?: { category?: string | null } }).stop_details
            ?.category;
          throw new FatalError(`summariser declined the request${why ? ` (${why})` : ''}`);
        }
        if (msg.stop_reason === 'model_context_window_exceeded')
          throw new FatalError('the transcript is too long for the summariser');
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
        const s = await call(SEGMENT_PROMPT, part, 4096, false);
        partSummaries.push(`Segment ${i + 1}:\n${s}`);
      }
      body = `The transcript was too long to send at once. Summaries of consecutive segments:\n\n${partSummaries.join('\n\n')}`;
    }

    const system = buildSummarySystemPrompt(input, speakers);
    let note = '';
    let lastError = '';
    let best: { value: ParsedSummary; missing: number } | null = null;
    for (let attempt = 0; attempt < MAX_SUMMARY_ATTEMPTS; attempt++) {
      let text: string;
      try {
        text = await call(system, body + note, SUMMARY_MAX_OUTPUT_TOKENS, true);
      } catch (err) {
        // A later attempt failing (truncated, busy, offline) must not throw away an earlier, mostly complete answer.
        if (best) break;
        throw err;
      }
      const parsed = parseSummary(text, [...speakers, 'Unassigned']);
      if (!parsed.ok) {
        lastError = parsed.error;
        note = retryNote(parsed.error);
        continue;
      }
      const missing = missingSections(parsed.value.summaryMarkdown);
      if (!missing.length) return { result: parsed.value, usage };
      // on a tie the later answer wins: it was written after being told what was missing
      if (!best || missing.length <= best.missing)
        best = { value: parsed.value, missing: missing.length };
      lastError = `missing sections: ${missing.join(', ')}`;
      note = retryNote(`its summary_markdown had no heading for ${missing.join(', ')}`);
    }
    // Still incomplete: keep the most complete answer and say plainly which sections were not produced.
    if (best)
      return {
        result: { ...best.value, summaryMarkdown: repairSections(best.value.summaryMarkdown) },
        usage,
      };
    return { result: null, usage, error: lastError };
  }
}
