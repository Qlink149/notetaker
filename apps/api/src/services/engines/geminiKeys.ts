import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { geminiKeyEntries } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { QuotaModel } from '../../models/index.js';

/**
 * Several Gemini API keys (GEMINI_API_KEY, GEMINI_API_KEY1..9), each with its own per-model daily
 * request quota on the free tier. A key that returns a daily-quota 429 is marked exhausted in
 * MongoDB until Google's stated reset, so no process spends another request on it (DECISIONS #15).
 */
export interface GeminiKey {
  /** Stable, non-secret id: the env variable name (e.g. GEMINI_API_KEY1). Never derived from the key. */
  id: string;
  /** The env variable it came from, for logs. */
  label: string;
  /**
   * Phase 1 stored the first 12 hex chars of sha256(key) as the id. Kept only to read old records;
   * `npm run p2:migrate-key-labels` rewrites them to labels.
   */
  legacyId?: string | null;
  client: GoogleGenAI;
}

/** The Phase 1 id of a key. Used only to recognise old stored records, never written. */
export const legacyKeyId = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 12);

let pool: GeminiKey[] | null = null;

export function geminiKeys(): GeminiKey[] {
  pool ??= geminiKeyEntries().map(({ name, value }) => ({
    id: name,
    label: name,
    legacyId: legacyKeyId(value),
    client: new GoogleGenAI({ apiKey: value }),
  }));
  return pool;
}

/** For tests: replace the pool (or reset it to the env keys with null). */
export function setGeminiKeysForTest(keys: GeminiKey[] | null): void {
  pool = keys;
}

export function keyById(id: string | null | undefined): GeminiKey | undefined {
  return id ? geminiKeys().find((k) => k.id === id || k.legacyId === id) : undefined;
}

/** The current id for a stored one (a Phase 1 hash id becomes its label); unknown ids pass through. */
export function canonicalKeyId(id: string | null | undefined): string | null {
  return id ? (keyById(id)?.id ?? id) : null;
}

export async function exhaustedUntil(keyId: string, model: string): Promise<Date | null> {
  const q = await QuotaModel.findById(`${keyId}:${model}`).lean();
  return q && q.exhaustedUntil > new Date() ? q.exhaustedUntil : null;
}

export async function markExhausted(
  key: GeminiKey,
  model: string,
  retryAfterMs: number,
): Promise<void> {
  const until = new Date(Date.now() + Math.max(60_000, retryAfterMs));
  await QuotaModel.updateOne(
    { _id: `${key.id}:${model}` },
    { $set: { exhaustedUntil: until, keyLabel: key.label, model } },
    { upsert: true },
  );
  logger.warn({ key: key.label, model, until }, 'gemini key quota exhausted');
}

/**
 * First key with quota left for `model`, preferring `preferId` (the key that already holds the
 * chunk's uploaded file, so no re-upload is needed). Returns the soonest reset when none is usable.
 */
export async function pickKey(
  model: string,
  preferId?: string | null,
): Promise<{ key: GeminiKey } | { key: null; resetAt: Date | null }> {
  const keys = geminiKeys();
  const prefer = canonicalKeyId(preferId);
  const ordered = [...keys].sort((a, b) => Number(b.id === prefer) - Number(a.id === prefer));
  let soonest: Date | null = null;
  for (const key of ordered) {
    const until = await exhaustedUntil(key.id, model);
    if (!until) return { key };
    if (!soonest || until < soonest) soonest = until;
  }
  return { key: null, resetAt: soonest };
}

/** "Please retry in 12h47m5s" / "retryDelay": "31s" → milliseconds. */
export function parseRetryDelayMs(message: string): number | null {
  const m =
    /retry in ((?:\d+h)?(?:\d+m)?(?:[\d.]+s)?)/i.exec(message) ??
    /"retryDelay":\s*"([\d.]+s)"/i.exec(message);
  if (!m?.[1]) return null;
  const h = /(\d+)h/.exec(m[1]);
  const min = /(\d+)m(?!s)/.exec(m[1]);
  const s = /([\d.]+)s/.exec(m[1]);
  const ms = ((Number(h?.[1] ?? 0) * 60 + Number(min?.[1] ?? 0)) * 60 + Number(s?.[1] ?? 0)) * 1000;
  return ms > 0 ? ms : null;
}

/** A 429 caused by a per-day quota (as opposed to a per-minute rate limit). */
export const isDailyQuota = (message: string): boolean => /per day|PerDay|daily/i.test(message);
