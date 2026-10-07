import { GoogleGenAI, FileState } from '@google/genai';
import { z } from 'zod';
import { TurnLang } from '@meetingid/shared';
import type { RawTurn } from '@meetingid/pipeline';
import { env, requireEnv } from '../../config/env.js';
import { FatalError, RetryableError, classify } from '../../pipeline/errors.js';
import { TRANSCRIPT_JSON_SCHEMA, buildTranscriptionInstruction } from './prompt.js';
import type { ChunkInput, ChunkResult, TranscriptionEngine } from './types.js';

const MAX_OUTPUT_TOKENS = 65_536;
const GEMINI_SEED = 20_260_927;
/** Below the 8-minute transcribe lease so a hung call never outlives its job lock. */
const REQUEST_TIMEOUT_MS = 7 * 60_000;

const RawTurnSchema = z.object({
  speaker: z.string(),
  start: z.coerce.number(),
  end: z.coerce.number(),
  text_native: z.string(),
  text_roman: z.string(),
  lang: TurnLang.catch('mixed'),
});
const ResponseSchema = z.object({ turns: z.array(RawTurnSchema) });

let client: GoogleGenAI | null = null;
export function geminiClient(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') });
  return client;
}

export interface UploadedFile {
  uri: string;
  name: string;
  mimeType: string;
}

/** Upload a local audio file to the Gemini Files API and wait until it is ACTIVE. */
export async function uploadToGeminiFiles(
  path: string,
  mimeType: string,
  displayName: string,
): Promise<UploadedFile> {
  const ai = geminiClient();
  try {
    let file = await ai.files.upload({ file: path, config: { mimeType, displayName } });
    for (let i = 0; file.state === FileState.PROCESSING && i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      file = await ai.files.get({ name: file.name! });
    }
    if (file.state === FileState.FAILED)
      throw new RetryableError(`Gemini file processing failed: ${file.name}`, 'server');
    if (!file.uri || !file.name)
      throw new RetryableError('Gemini upload returned no file uri', 'server');
    return { uri: file.uri, name: file.name, mimeType: file.mimeType ?? mimeType };
  } catch (err) {
    throw classify(err);
  }
}

export async function deleteGeminiFile(name: string): Promise<void> {
  await geminiClient().files.delete({ name });
}

/** Parse and validate the model's JSON. Invalid output is retryable (the model is non-deterministic). */
export function parseTranscriptJson(text: string | undefined): RawTurn[] {
  if (!text?.trim())
    throw new RetryableError('Gemini returned an empty response', 'invalid_output');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new RetryableError(
      `Gemini returned invalid JSON: ${(e as Error).message}`,
      'invalid_output',
    );
  }
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RetryableError(
      `Gemini JSON did not match the schema: ${parsed.error.message.slice(0, 300)}`,
      'invalid_output',
    );
  }
  return parsed.data.turns;
}

/** Primary engine: Gemini Flash with audio input and structured JSON output. */
export class GeminiEngine implements TranscriptionEngine {
  readonly name = 'gemini' as const;
  readonly accepts = ['gemini-file', 'path'] as ChunkInput['audio']['kind'][];

  constructor(private readonly model = env().GEMINI_MODEL) {}

  async transcribeChunk(input: ChunkInput): Promise<ChunkResult> {
    let audio: { uri: string; mimeType: string };
    if (input.audio.kind === 'gemini-file') audio = input.audio;
    else if (input.audio.kind === 'path') {
      audio = await uploadToGeminiFiles(input.audio.path, input.audio.mimeType, 'chunk');
    } else throw new FatalError('GeminiEngine needs a local file or an uploaded Gemini file');

    let interaction;
    try {
      interaction = await geminiClient().interactions.create(
        {
          model: this.model,
          system_instruction: buildTranscriptionInstruction(input.languages, input.glossary),
          input: [
            {
              type: 'text',
              text: 'Transcribe this audio following the rules exactly. Return only the JSON object.',
            },
            { type: 'audio', uri: audio.uri, mime_type: audio.mimeType },
          ],
          response_format: {
            type: 'text',
            mime_type: 'application/json',
            schema: TRANSCRIPT_JSON_SCHEMA,
          },
          // No temperature on the Interactions API (DECISIONS #9); a fixed seed keeps reruns comparable.
          generation_config: {
            max_output_tokens: MAX_OUTPUT_TOKENS,
            thinking_level: 'low',
            seed: GEMINI_SEED,
          },
          store: false,
        },
        { timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 },
      );
    } catch (err) {
      throw classify(err);
    }

    const usage = {
      inputTokens: interaction.usage?.total_input_tokens ?? 0,
      outputTokens:
        (interaction.usage?.total_output_tokens ?? 0) +
        (interaction.usage?.total_thought_tokens ?? 0),
      audioSec: 0,
    };
    if (interaction.status === 'incomplete' || interaction.status === 'budget_exceeded') {
      return { turns: [], usage, model: this.model, finish: 'truncated' };
    }
    if (interaction.status !== 'completed') {
      const detail = interaction.errors?.map((e) => JSON.stringify(e)).join('; ') ?? '';
      throw new RetryableError(
        `Gemini interaction ended with status ${interaction.status} ${detail}`,
        'server',
      );
    }
    return {
      turns: parseTranscriptJson(interaction.output_text),
      usage,
      model: this.model,
      finish: 'complete',
    };
  }
}
