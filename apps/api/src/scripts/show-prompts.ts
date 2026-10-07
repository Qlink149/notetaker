import { formatLinesForSummary } from '@meetingid/pipeline';
import { buildTranscriptionInstruction } from '../services/engines/prompt.js';
import { buildSummarySystemPrompt } from '../services/summary/claude.js';
import { SEED_GLOSSARY } from './seed.js';

// Print the exact prompts sent to Gemini and Claude for the Kisna workspace (no API calls):
//   npx tsx --conditions=source src/scripts/show-prompts.ts
const glossary = { entries: SEED_GLOSSARY };
const languages = ['hi', 'gu', 'en'] as const;
const line = (s: string) => console.log(`\n========== ${s} ==========`);

line('GEMINI system_instruction');
console.log(buildTranscriptionInstruction([...languages], glossary));
line('GEMINI input[0] (text part; input[1] is the chunk audio file)');
console.log('Transcribe this audio following the rules exactly. Return only the JSON object.');
line('CLAUDE system');
console.log(
  buildSummarySystemPrompt({ glossary, languages: [...languages] }, ['Speaker 1', 'Speaker 2']),
);
line('CLAUDE user message (shape)');
console.log(
  `Transcript:\n${formatLinesForSummary([
    {
      speakerName: 'Speaker 1',
      start: 65,
      end: 70,
      textRoman: 'Kisna ka Q3 plan dekhte hain.',
      textNative: '',
    },
    { speakerName: 'Speaker 2', start: 71, end: 72, textRoman: 'haan ji.', textNative: '' },
  ])}`,
);
