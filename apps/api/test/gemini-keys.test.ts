import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GoogleGenAI } from '@google/genai';
import { resetEnvCache } from '../src/config/env.js';
import { QuotaModel } from '../src/models/index.js';
import { RetryableError } from '../src/pipeline/errors.js';
import { GeminiEngine, storableResponse } from '../src/services/engines/gemini.js';
import { TRANSCRIBE_PROMPT_VERSION } from '../src/services/engines/prompt.js';
import { rawOf } from '../src/services/engines/types.js';
import {
  isDailyQuota,
  parseRetryDelayMs,
  setGeminiKeysForTest,
  type GeminiKey,
} from '../src/services/engines/geminiKeys.js';
import { clearDb, startDb, stopDb } from './helpers.js';

const DAILY =
  '429 Rate limit exceeded for model gemini-3.8-flash (limit: 20 requests per day on Free Tier). Please retry in 12h47m5s or upgrade your tier.';

interface Call {
  key: string;
  op: 'upload' | 'create';
  model?: string;
}

function fakeKey(
  id: string,
  calls: Call[],
  behaviour: (model: string) => 'ok' | 'daily' | 'overload' | 'badjson',
): GeminiKey {
  const ok = {
    status: 'completed',
    output_text: JSON.stringify({
      turns: [
        {
          speaker: 'S1',
          start: 0,
          end: 2,
          text_native: 'नमस्ते',
          text_roman: 'namaste',
          lang: 'hi',
        },
      ],
    }),
    usage: { total_input_tokens: 100, total_output_tokens: 20 },
    // attached by the real SDK to every non-streaming reply
    sdkHttpResponse: { headers: { 'content-type': 'application/json' } },
  };
  const client = {
    files: {
      upload: async () => {
        calls.push({ key: id, op: 'upload' });
        return { uri: `uri-${id}`, name: `files/${id}`, mimeType: 'audio/flac', state: 'ACTIVE' };
      },
      get: async () => ({}),
    },
    interactions: {
      create: async (p: { model: string }) => {
        calls.push({ key: id, op: 'create', model: p.model });
        const b = behaviour(p.model);
        if (b === 'daily') throw Object.assign(new Error(DAILY), { status: 429 });
        if (b === 'overload') throw Object.assign(new Error('503 high demand'), { status: 503 });
        if (b === 'badjson') return { ...ok, output_text: '{"turns": [{"speaker": "S1"' };
        return ok;
      },
    },
  } as unknown as GoogleGenAI;
  return { id, label: `KEY_${id}`, client };
}

const input = (keyId: string | null) => ({
  audio: { kind: 'gemini-file' as const, uri: `uri-${keyId}`, mimeType: 'audio/flac', keyId },
  localPath: async () => 'chunk.flac',
  startSec: 0,
  endSec: 60,
  languages: ['hi' as const],
  glossary: null,
});

describe('gemini key pool', () => {
  beforeAll(async () => {
    await startDb();
    process.env.GEMINI_MODEL = 'gemini-3.8-flash';
    process.env.GEMINI_FALLBACK_MODEL = 'gemini-3.5-flash';
    resetEnvCache();
  });
  afterAll(async () => {
    setGeminiKeysForTest(null);
    await stopDb();
  });
  beforeEach(clearDb);

  it('parses quota messages', () => {
    expect(isDailyQuota(DAILY)).toBe(true);
    expect(isDailyQuota('429 too many requests per minute')).toBe(false);
    expect(parseRetryDelayMs(DAILY)).toBe((12 * 3600 + 47 * 60 + 5) * 1000);
    expect(parseRetryDelayMs('{"retryDelay": "31s"}')).toBe(31_000);
    expect(parseRetryDelayMs('nothing')).toBeNull();
  });

  it('moves to the next key on a daily quota and remembers it (no request wasted later)', async () => {
    const calls: Call[] = [];
    setGeminiKeysForTest([fakeKey('a', calls, () => 'daily'), fakeKey('b', calls, () => 'ok')]);
    const engine = new GeminiEngine('gemini-3.8-flash', 'gemini-3.5-flash');

    const r = await engine.transcribeChunk(input('a'));
    expect(r.model).toBe('gemini-3.8-flash');
    expect(r.uploaded?.keyId).toBe('b'); // file re-uploaded under key b (files are per project)
    expect(calls.map((c) => `${c.key}:${c.op}`)).toEqual(['a:create', 'b:upload', 'b:create']);
    const q = await QuotaModel.findById('a:gemini-3.8-flash').lean();
    expect(q?.exhaustedUntil.getTime()).toBeGreaterThan(Date.now() + 12 * 3600_000);

    calls.length = 0;
    await engine.transcribeChunk(input('b'));
    expect(calls.map((c) => `${c.key}:${c.op}`)).toEqual(['b:create']); // key a never called again
  });

  it('tries the fallback model once when the primary is overloaded', async () => {
    const calls: Call[] = [];
    setGeminiKeysForTest([
      fakeKey('a', calls, (m) => (m === 'gemini-3.8-flash' ? 'overload' : 'ok')),
    ]);
    const r = await new GeminiEngine('gemini-3.8-flash', 'gemini-3.5-flash').transcribeChunk(
      input('a'),
    );
    expect(r.model).toBe('gemini-3.5-flash');
    expect(calls.map((c) => c.model)).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash']);
  });

  it('returns the untouched reply with model and prompt version', async () => {
    setGeminiKeysForTest([fakeKey('a', [], () => 'ok')]);
    const r = await new GeminiEngine('gemini-3.8-flash', null).transcribeChunk(input('a'));
    expect(r.raw?.model).toBe('gemini-3.8-flash');
    expect(r.raw?.promptVersion).toBe(TRANSCRIBE_PROMPT_VERSION);
    expect(r.raw?.promptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.raw?.prompt).toContain('01:00.0'); // the chunk length is part of the stored prompt
    expect(JSON.parse(r.raw!.text!).turns[0].text_roman).toBe('namaste');
    expect((r.raw?.response as { status: string }).status).toBe('completed');
    expect(r.raw?.keyLabel).toBe('KEY_a'); // the label, never the key
    expect(JSON.stringify(r.raw?.response)).not.toContain('sdkHttpResponse');
  });

  it('stores the body only: SDK HTTP metadata dropped, any key value masked', () => {
    const secret = 'AIzaFAKE-not-a-real-key-000';
    const stored = storableResponse(
      {
        id: 'int-1',
        status: 'completed',
        output_text: `echo ${secret}`,
        sdkHttpResponse: { headers: { 'x-goog-api-key': secret, date: 'today' } },
      },
      [secret],
    );
    expect(stored).toEqual({ id: 'int-1', status: 'completed', output_text: 'echo [redacted]' });
    expect(JSON.stringify(stored)).not.toContain(secret);
  });

  it('keeps an unparseable reply on the error it throws', async () => {
    setGeminiKeysForTest([fakeKey('a', [], () => 'badjson')]);
    const err = await new GeminiEngine('gemini-3.8-flash', null)
      .transcribeChunk(input('a'))
      .catch((e: unknown) => e);
    expect((err as RetryableError).reason).toBe('invalid_output');
    expect(rawOf(err)?.text).toBe('{"turns": [{"speaker": "S1"');
  });

  it('waits for the reset (quota retry) when every key is exhausted for every model', async () => {
    const calls: Call[] = [];
    setGeminiKeysForTest([fakeKey('a', calls, () => 'daily'), fakeKey('b', calls, () => 'daily')]);
    const err = await new GeminiEngine('gemini-3.8-flash', 'gemini-3.5-flash')
      .transcribeChunk(input('a'))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).reason).toBe('quota');
    expect((err as RetryableError).retryAfterMs).toBeGreaterThan(12 * 3600_000);
    // one request per key per model, then nothing more
    expect(calls.filter((c) => c.op === 'create')).toHaveLength(4);
  });
});
