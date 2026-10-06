import type { Glossary, Language } from '@meetingid/shared';
import { renderGlossaryForPrompt } from '@meetingid/pipeline';
import { LANGUAGE_NAMES } from './types.js';

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
            type: 'number',
            description: 'Start time in seconds from the start of this audio',
          },
          end: { type: 'number', description: 'End time in seconds from the start of this audio' },
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
    '7. start and end are in seconds from the start of THIS audio file (e.g. 754.2 for 12 minutes 34.2 seconds), decimals allowed, and start values never decrease.',
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
