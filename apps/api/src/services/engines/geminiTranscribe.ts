import type { RawTurn } from '@meetingid/pipeline';
import { env } from '../../config/env.js';
import { FatalError, RetryableError, classify } from '../../pipeline/errors.js';
import { geminiClient, uploadToGeminiFiles } from './gemini.js';
import {
  LANGUAGE_BCP47,
  type ChunkInput,
  type ChunkResult,
  type TranscriptionEngine,
} from './types.js';

interface WordInfo {
  type: 'word_info';
  text: string;
  speaker?: string;
  start_offset?: string;
  end_offset?: string;
}
interface StepContent {
  type: string;
  text?: string;
  annotations?: WordInfo[];
}
interface Step {
  type: string;
  content?: StepContent[];
}

/** `"12.340s"` → 12.34 */
const seconds = (offset: string | undefined): number => Number.parseFloat(offset ?? '0') || 0;

/** Group word annotations into turns: a new turn on speaker change or a pause over 1 s. */
export function wordsToTurns(words: WordInfo[]): RawTurn[] {
  const turns: RawTurn[] = [];
  let cur: { speaker: string; start: number; end: number; words: string[] } | null = null;
  const flush = (): void => {
    if (!cur) return;
    const text = cur.words.join(' ');
    turns.push({
      speaker: cur.speaker,
      start: cur.start,
      end: cur.end,
      text_native: text,
      text_roman: text,
      lang: 'mixed',
    });
  };
  for (const w of words) {
    const speaker = (w.speaker ?? 'spk_1').replace(/^spk_/, 'S');
    const start = seconds(w.start_offset);
    const end = seconds(w.end_offset);
    if (cur && cur.speaker === speaker && start - cur.end <= 1) {
      cur.words.push(w.text);
      cur.end = end;
    } else {
      flush();
      cur = { speaker, start, end, words: [w.text] };
    }
  }
  flush();
  return turns;
}

/**
 * Benchmark-only adapter for `gemini-3.5-transcribe` (verbatim mode, diarization, word timestamps).
 * Its custom vocabulary cannot be combined with diarization or timestamps, so the glossary is not
 * used here, and it outputs a single script (no separate romanisation).
 */
export class GeminiTranscribeEngine implements TranscriptionEngine {
  readonly name = 'gemini-transcribe' as const;
  readonly accepts = ['gemini-file', 'path'] as ChunkInput['audio']['kind'][];

  constructor(private readonly model = env().GEMINI_TRANSCRIBE_MODEL) {}

  async transcribeChunk(input: ChunkInput): Promise<ChunkResult> {
    if (input.endSec - input.startSec > 30 * 60) {
      throw new FatalError('gemini-transcribe is limited to 30 minutes with diarization');
    }
    let audio: { uri: string; mimeType: string };
    if (input.audio.kind === 'gemini-file') audio = input.audio;
    else if (input.audio.kind === 'path') {
      audio = await uploadToGeminiFiles(input.audio.path, input.audio.mimeType, 'chunk');
    } else
      throw new FatalError('GeminiTranscribeEngine needs a local file or an uploaded Gemini file');

    let interaction;
    try {
      interaction = await geminiClient().interactions.create(
        {
          model: this.model,
          input: [{ type: 'audio', uri: audio.uri, mime_type: audio.mimeType }],
          generation_config: {
            transcription_config: {
              language_codes: input.languages.map((l) => LANGUAGE_BCP47[l]),
              mode: {
                type: 'verbatim',
                diarization_mode: 'speaker',
                timestamp_granularities: ['word'],
              },
            },
          },
          store: false,
        } as Parameters<ReturnType<typeof geminiClient>['interactions']['create']>[0],
        { timeout: 7 * 60_000, maxRetries: 1 },
      );
    } catch (err) {
      throw classify(err);
    }
    if (!('status' in interaction) || interaction.status !== 'completed') {
      throw new RetryableError(
        `gemini-transcribe ended with status ${String((interaction as { status?: string }).status)}`,
        'server',
      );
    }
    const steps = (interaction.steps ?? []) as unknown as Step[];
    const words = steps
      .flatMap((s) => s.content ?? [])
      .flatMap((c) => c.annotations ?? [])
      .filter((a): a is WordInfo => a.type === 'word_info');
    return {
      turns: wordsToTurns(words),
      usage: {
        inputTokens: interaction.usage?.total_input_tokens ?? 0,
        outputTokens: interaction.usage?.total_output_tokens ?? 0,
        audioSec: 0,
      },
      model: this.model,
      finish: 'complete',
    };
  }
}
