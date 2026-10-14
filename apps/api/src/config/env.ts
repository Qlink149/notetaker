import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

/** Optional string; a blank value in .env (`KEY=`) counts as unset. */
const optional = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().optional(),
);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.string().default('info'),

  MONGODB_URI: z.string().min(1),
  /** Database name; used when MONGODB_URI has none in its path. */
  MONGODB_DB: z.string().default('meetingid'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** Access code for the seeded workspace; used by the seed script and as a login fallback. */
  WORKSPACE_ACCESS_CODE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(6).optional(),
  ),
  CORS_ORIGINS: csv,

  GEMINI_API_KEY: optional,
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
  /** Tried once when the primary model is overloaded (503/timeout) or out of quota on every key. Empty = none. */
  GEMINI_FALLBACK_MODEL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().default('gemini-3.5-flash'),
  ),
  /** Set to "true" when the Gemini keys are on a paid tier; free-tier usage costs nothing and is not counted against the cap. */
  /**
   * Names (comma separated, e.g. GEMINI_API_KEY4) of Gemini keys on the FREE tier. Google may use content
   * sent through a free key to improve its products and humans may read it, so such keys are left out
   * of the pool unless GEMINI_ALLOW_FREE_KEYS is true (demos and tests with non-client audio only).
   */
  GEMINI_FREE_KEYS: z.string().default(''),
  /** Where recordings are kept: Cloudinary (the original setup) or Backblaze B2 (S3-compatible, private). */
  STORAGE_PROVIDER: z.enum(['cloudinary', 'b2']).default('cloudinary'),
  B2_ENDPOINT: optional, // e.g. https://s3.us-west-004.backblazeb2.com
  B2_REGION: optional, // e.g. us-west-004
  B2_BUCKET: optional,
  B2_KEY_ID: optional,
  B2_APPLICATION_KEY: optional,
  /** Public address of this API (https://...), used to build audio playback links. */
  PUBLIC_API_URL: optional,
  GEMINI_ALLOW_FREE_KEYS: z
    .preprocess((v) => v === 'true' || v === '1', z.boolean())
    .default(false),
  GEMINI_PAID: z.preprocess((v) => v === 'true' || v === '1', z.boolean()).default(false),
  /**
   * Who writes summaries: 'anthropic' (production, Messages API) or 'handoff' (testing: the request is
   * stored in MongoDB and answered by an external agent via `npm run handoff`; no API spend).
   */
  SUMMARY_PROVIDER: z.enum(['anthropic', 'handoff']).default('anthropic'),
  /**
   * Where speaker labels come from. "pyannote" (default when PYANNOTEAI_API_KEY is set) diarizes the
   * audio and joins it to the transcript; "text" keeps Phase 1's text-based linking between chunks.
   */
  SPEAKER_SOURCE: z.enum(['pyannote', 'text']).optional(),
  /** "off" skips the gap-fill stage (it is the only stage that calls Gemini again after transcription). */
  GAPFILL: z.enum(['on', 'off']).default('on'),
  /** Hard cap in USD on recorded Gemini (if paid) + Claude spend across all meetings and benchmarks. */
  SPEND_CAP_USD: z.coerce.number().positive().default(5),
  GEMINI_TRANSCRIBE_MODEL: z.string().default('gemini-3.5-transcribe'),
  DEEPGRAM_API_KEY: optional,
  ANTHROPIC_API_KEY: optional,
  PYANNOTEAI_API_KEY: optional,
  /**
   * A second pyannote account used ONLY for voiceprints (/voiceprint, the clip upload it reads and its
   * job polling: media and jobs belong to the account that made them). Optional: voiceprints use
   * PYANNOTEAI_API_KEY when it is not set. Needed when the main account has no voiceprint allowance.
   */
  PYANNOTEAI_VOICEPRINT_API_KEY: optional,
  SARVAM_API_KEY: optional,
  /** Unused in Phase 1 (kept from the Base44 app). */
  OPENAI_API_KEY: optional,

  CLOUDINARY_CLOUD_NAME: optional,
  CLOUDINARY_API_KEY: optional,
  CLOUDINARY_API_SECRET: optional,

  WORKER_ID: optional,
  /** true = the worker also listens on PORT with GET /health (for running it as a Render web service). */
  /**
   * Addresses this process calls every 8 minutes to keep other free Render services awake (they sleep
   * after 15 minutes without a request). Set on the API to the worker's /health address.
   */
  KEEPALIVE_URLS: csv,
  /**
   * true (default): voices that pyannote split in two but that are clearly one voice (it hears each as the
   * other, never at the same moment) are merged when a meeting's speakers are first set up. Set to false to
   * switch the merge off without a deploy of new code.
   */
  SPEAKER_AUTOMERGE: z.preprocess((v) => !(v === 'false' || v === '0'), z.boolean()).default(true),
  WORKER_HTTP: z.preprocess((v) => v === 'true' || v === '1', z.boolean()).default(false),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /**
   * Chunks transcribed at the same moment, on their own lane next to the WORKER_CONCURRENCY lane that runs every
   * other stage. A transcription job only waits for Gemini and holds a link to audio already uploaded, so several
   * fit on a small worker; the heavy stages (ingest, speaker analysis, gap fill) stay on the other lane.
   * 0 puts transcription back on the shared lane, one job at a time per WORKER_CONCURRENCY slot.
   */
  WORKER_TRANSCRIBE_CONCURRENCY: z.coerce.number().int().min(0).max(8).default(4),
  /** Most Gemini requests in flight at once from one worker, whichever stage sends them (rate-limit guard). */
  GEMINI_MAX_CONCURRENT: z.coerce.number().int().min(1).max(16).default(6),
  FFMPEG_PATH: optional,
  FFPROBE_PATH: optional,
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** Validated environment. Throws with every problem listed if anything required is missing. */
export function env(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${problems}`);
  }
  cached = parsed.data;
  return cached;
}

/** For tests that change process.env between cases. */
export function resetEnvCache(): void {
  cached = null;
}

/** A feature was used whose configuration is missing. Never retried. */
export class MissingConfigError extends Error {
  override readonly name = 'MissingConfigError';
}

/** Read a variable that a specific feature needs; fails with a clear message when absent. */
export function requireEnv(key: keyof Env): string {
  const value = env()[key];
  if (typeof value !== 'string' || value === '') {
    throw new MissingConfigError(`${key} is not set (see .env.example)`);
  }
  return value;
}

export type EngineId = 'gemini' | 'deepgram' | 'gemini-transcribe' | 'sarvam';

/** Which engines can run with the current configuration, and why not when they cannot. */
export function engineStatus(): Record<EngineId, { enabled: boolean; reason?: string }> {
  const e = env();
  const key = (v: string | undefined, name: string) =>
    v ? { enabled: true } : { enabled: false, reason: `${name} is not set` };
  return {
    gemini: key(
      geminiKeyEntries()[0]?.value,
      'GEMINI_PAID_API_KEY (or GEMINI_API_KEY, GEMINI_API_KEY1..9)',
    ),
    deepgram: key(e.DEEPGRAM_API_KEY, 'DEEPGRAM_API_KEY'),
    'gemini-transcribe': key(
      geminiKeyEntries()[0]?.value,
      'GEMINI_API_KEY (or GEMINI_API_KEY1..9)',
    ),
    sarvam: { enabled: false, reason: 'Sarvam is not implemented in Phase 1' },
  };
}

/**
 * Gemini keys from GEMINI_PAID_API_KEY (the paid key, used first), GEMINI_API_KEY and GEMINI_API_KEY1..GEMINI_API_KEY9,
 * in that order, de-duplicated.
 * Keys listed in GEMINI_FREE_KEYS are skipped unless GEMINI_ALLOW_FREE_KEYS is true.
 */
export function geminiKeyEntries(): { name: string; value: string }[] {
  const names = [
    'GEMINI_PAID_API_KEY',
    'GEMINI_API_KEY',
    ...Array.from({ length: 9 }, (_, i) => `GEMINI_API_KEY${i + 1}`),
  ];
  const seen = new Set<string>();
  const out: { name: string; value: string }[] = [];
  const e = env();
  const free = new Set(
    e.GEMINI_FREE_KEYS.split(',')
      .map((n) => n.trim())
      .filter(Boolean),
  );
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (!value || seen.has(value)) continue;
    if (free.has(name) && !e.GEMINI_ALLOW_FREE_KEYS) continue;
    seen.add(value);
    out.push({ name, value });
  }
  return out;
}
