import type { Glossary, Language } from '@meetingid/shared';
import { renderGlossaryForPrompt } from '@meetingid/pipeline';
import { LANGUAGE_NAMES } from './types.js';

/**
 * Version of the transcription prompt template and schema. Bump it whenever the instruction text,
 * user text or schema changes, so stored responses say which prompt produced them.
 * v1: numeric-second timestamps. v2 (2026-10-07): "MM:SS.s" timestamps and the chunk length in rule 7.
 */
export const TRANSCRIBE_PROMPT_VERSION = 'v2';
export const TRANSCRIBE_USER_TEXT =
  'Transcribe this audio following the rules exactly. Return only the JSON object.';

/** JSON Schema for one chunk's transcription (Gemini structured output). */
export const TRANSCRIPT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    turns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          speaker: { type: 'string', description: 'S1, S2, … in order of first appearance' },
          start: {
            type: 'string',
            description: 'Start time as MM:SS.s from the start of this audio, e.g. "07:41.5"',
          },
          end: {
            type: 'string',
            description: 'End time as MM:SS.s from the start of this audio, e.g. "07:44.0"',
          },
          text_native: { type: 'string' },
          text_roman: { type: 'string' },
          lang: { type: 'string', enum: ['hi', 'gu', 'en', 'mixed'] },
        },
        required: ['speaker', 'start', 'end', 'text_native', 'text_roman', 'lang'],
      },
    },
  },
  required: ['turns'],
} as const;

/** System instruction for transcribing one chunk. Precise rules matter more than length. */
export function buildTranscriptionInstruction(
  languages: Language[],
  glossary: Glossary | null,
  durationSec = 600,
): string {
  const langs = (languages.length ? languages : (['hi', 'gu', 'en'] as Language[]))
    .map((l) => LANGUAGE_NAMES[l])
    .join(', ');
  const glossaryBlock = renderGlossaryForPrompt(glossary);
  const rules = [
    `You are transcribing one segment of a business meeting recorded in India. Languages spoken: ${langs}, often mixed within one sentence.`,
    'Rules:',
    '1. Transcribe everything spoken, verbatim, including fillers, false starts, interjections and short overlapping responses ("haan", "ji", "achha", "yes sir"). Give each short response its own turn.',
    '2. One turn per speaker utterance. Start a new turn whenever the speaker changes, even in the middle of a sentence.',
    '3. Label speakers S1, S2, S3, … in order of first appearance within this audio. Use the same label for the same voice throughout this audio.',
    '4. text_native: Devanagari for Hindi, Gujarati script for Gujarati, Latin script for English words, mixed within a sentence exactly as spoken.',
    '5. text_roman: the same content entirely in Latin script. Keep English words unchanged; romanise Hindi and Gujarati words phonetically (e.g. "aapne report bheji?"). Preserve punctuation. Never translate.',
    '6. Do not translate. Do not summarise. Do not skip or shorten low-volume or overlapping speech. Do not repeat text that was not spoken again.',
    '7. start and end are timestamps "MM:SS.s" measured from the start of THIS audio file (e.g. "07:34.2" for 7 minutes 34.2 seconds). This audio is exactly ' +
      formatDuration(durationSec) +
      ' long: no timestamp may exceed that. Track the time carefully all the way to the end; start values never decrease.',
    '8. lang: "hi", "gu" or "en" when a turn is in one language, "mixed" when it mixes languages.',
    '9. If a stretch is unintelligible, write [inaudible] for it rather than guessing.',
  ];
  if (glossaryBlock) {
    rules.push(
      `10. Spell the following names and terms exactly as given whenever they are spoken: ${glossaryBlock}`,
    );
  }
  return rules.join('\n');
}

/** 600 → "10:00.0" */
export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}
