import { FileState, type GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { TurnLang } from '@meetingid/shared';
import { parseTimestamp, type RawTurn } from '@meetingid/pipeline';
import { MissingConfigError, env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { FatalError, RetryableError, classify } from '../../pipeline/errors.js';
import {
  geminiKeys,
  isDailyQuota,
  keyById,
  markExhausted,
  parseRetryDelayMs,
  pickKey,
  type GeminiKey,
} from './geminiKeys.js';
import { TRANSCRIPT_JSON_SCHEMA, buildTranscriptionInstruction } from './prompt.js';
import type { ChunkInput, ChunkResult, TranscriptionEngine } from './types.js';

const MAX_OUTPUT_TOKENS = 65_536;
const GEMINI_SEED = 20_260_927;
/**
 * A 10-minute chunk normally returns in 1–3 min. Calls to an overloaded model hang for minutes and
 * then fail, so give up at 4 min (well under the 8-minute transcribe lease).
 */
const REQUEST_TIMEOUT_MS = 4 * 60_000;

const RawTurnSchema = z.object({
  speaker: z.string(),
  // "MM:SS.s" strings (what the schema asks for) or plain seconds
  start: z.union([z.number(), z.string()]).transform(parseTimestamp),
  end: z.union([z.number(), z.string()]).transform(parseTimestamp),
  text_native: z.string(),
  text_roman: z.string(),
  lang: TurnLang.catch('mixed'),
});
const ResponseSchema = z.object({ turns: z.array(RawTurnSchema) });

export interface UploadedFile {
  uri: string;
  name: string;
  mimeType: string;
  keyId: string;
}

export async function uploadWith(
  key: GeminiKey,
  path: string,
  mimeType: string,
  displayName: string,
): Promise<UploadedFile> {
  const ai: GoogleGenAI = key.client;
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
    return { uri: file.uri, name: file.name, mimeType: file.mimeType ?? mimeType, keyId: key.id };
  } catch (err) {
    throw classify(err);
  }
}

/** Upload under the first key that still has quota for the primary model (uploads are free). */
export async function uploadToGeminiFiles(
  path: string,
  mimeType: string,
  displayName: string,
): Promise<UploadedFile> {
  const picked = await pickKey(env().GEMINI_MODEL);
  const key = picked.key ?? (await pickKey(fallbackModel() ?? env().GEMINI_MODEL)).key;
  if (!key) throw new MissingConfigError('No Gemini key with quota left (GEMINI_API_KEY*)');
  return uploadWith(key, path, mimeType, displayName);
}

export async function deleteGeminiFile(name: string, keyId?: string | null): Promise<void> {
  const one = keyById(keyId);
  const keys = one ? [one] : geminiKeys();
  for (const k of keys) {
    try {
      await k.client.files.delete({ name });
      return;
    } catch {
      // try the next key: files belong to one project
    }
  }
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

function fallbackModel(): string | null {
  const f = env().GEMINI_FALLBACK_MODEL;
  return f && f !== 'none' && f !== env().GEMINI_MODEL ? f : null;
}

/** Overloaded / unavailable model: worth one try on the fallback model. */
const isOverload = (err: unknown): boolean => {
  const e = err as { status?: number; message?: string; constructor?: { name?: string } };
  return (
    e?.status === 503 ||
    e?.status === 504 ||
    /timed out|timeout|DEADLINE_EXCEEDED|high demand|overloaded/i.test(String(e?.message)) ||
    /Timeout/.test(String(e?.constructor?.name))
  );
};

/** Primary engine: Gemini Flash with audio input and structured JSON output. */
export class GeminiEngine implements TranscriptionEngine {
  readonly name = 'gemini' as const;
  readonly accepts = ['gemini-file', 'path'] as ChunkInput['audio']['kind'][];

  constructor(
    private readonly model = env().GEMINI_MODEL,
    private readonly fallback: string | null = fallbackModel(),
  ) {}

  /**
   * One request per attempt where possible: the primary model on a key with quota (preferring the key
   * that already holds the uploaded file), then — only if the primary is overloaded or out of quota on
   * every key — one request on the fallback model.
   */
  async transcribeChunk(input: ChunkInput): Promise<ChunkResult> {
    const models = [this.model, ...(this.fallback ? [this.fallback] : [])];
    let uploaded: ChunkResult['uploaded'];
    let lastErr: unknown = null;
    let soonestReset: Date | null = null;

    for (const model of models) {
      // Keys for this model, until one works or all are out of daily quota.
      for (;;) {
        const preferId = input.audio.kind === 'gemini-file' ? input.audio.keyId : uploaded?.keyId;
        const picked = await pickKey(model, preferId);
        if (!picked.key) {
          if (picked.resetAt && (!soonestReset || picked.resetAt < soonestReset))
            soonestReset = picked.resetAt;
          break;
        }
        const key = picked.key;

        // The file must live in the same project as the key.
        let file: { uri: string; mimeType: string };
        if (input.audio.kind === 'gemini-file' && (input.audio.keyId ?? key.id) === key.id) {
          file = input.audio;
        } else if (uploaded && uploaded.keyId === key.id) {
          file = { uri: uploaded.uri, mimeType: 'audio/flac' };
        } else {
          const path =
            input.audio.kind === 'path'
              ? input.audio.path
              : input.localPath
                ? await input.localPath()
                : null;
          if (!path)
            throw new FatalError('GeminiEngine needs a local file to upload under another key');
          const up = await uploadWith(key, path, input.audio.mimeType, 'chunk');
          uploaded = { uri: up.uri, name: up.name, keyId: up.keyId };
          file = { uri: up.uri, mimeType: up.mimeType };
        }

        try {
          const result = await this.call(key, model, file, input);
          return { ...result, ...(uploaded ? { uploaded } : {}) };
        } catch (err) {
          const msg = String((err as Error)?.message ?? err);
          const status = (err as { status?: number }).status;
          if (status === 429 && isDailyQuota(msg)) {
            await markExhausted(key, model, parseRetryDelayMs(msg) ?? 24 * 3600_000);
            continue; // next key, same model
          }
          if (status === 429) {
            // per-minute limit: wait as told, no attempt used
            throw new RetryableError(`Gemini rate limit: ${msg.slice(0, 200)}`, 'quota', {
              cause: err,
              retryAfterMs: parseRetryDelayMs(msg) ?? 60_000,
            });
          }
          if (isOverload(err) && model !== models.at(-1)) {
            logger.warn(
              { model, key: key.label, err: msg.slice(0, 200) },
              'gemini overloaded; trying fallback model',
            );
            lastErr = err;
            break; // next model
          }
          throw classify(err);
        }
      }
    }

    if (lastErr) throw classify(lastErr);
    const wait = soonestReset ? Math.max(60_000, soonestReset.getTime() - Date.now()) : 3600_000;
    throw new RetryableError(
      `Gemini daily quota used up on every key for ${models.join(' and ')}; retrying after the reset`,
      'quota',
      { retryAfterMs: wait },
    );
  }

  private async call(
    key: GeminiKey,
    model: string,
    file: { uri: string; mimeType: string },
    input: ChunkInput,
  ): Promise<ChunkResult> {
    const interaction = await key.client.interactions.create(
      {
        model,
        system_instruction: buildTranscriptionInstruction(
          input.languages,
          input.glossary,
          input.endSec - input.startSec,
        ),
        input: [
          {
            type: 'text',
            text: 'Transcribe this audio following the rules exactly. Return only the JSON object.',
          },
          { type: 'audio', uri: file.uri, mime_type: file.mimeType },
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
      // No SDK retries: every request counts against the daily quota; the job queue retries.
      { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 },
    );

    const usage = {
      inputTokens: interaction.usage?.total_input_tokens ?? 0,
      outputTokens:
        (interaction.usage?.total_output_tokens ?? 0) +
        (interaction.usage?.total_thought_tokens ?? 0),
      audioSec: 0,
    };
    if (interaction.status === 'incomplete' || interaction.status === 'budget_exceeded') {
      return { turns: [], usage, model, finish: 'truncated' };
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
      model,
      finish: 'complete',
    };
  }
}
