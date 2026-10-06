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

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.string().default('info'),

  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** Access code for the seeded workspace; used by the seed script and as a login fallback. */
  WORKSPACE_ACCESS_CODE: z.string().min(6).optional(),
  CORS_ORIGINS: csv,

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
  GEMINI_TRANSCRIBE_MODEL: z.string().default('gemini-3.5-transcribe'),
  DEEPGRAM_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  PYANNOTEAI_API_KEY: z.string().optional(),
  SARVAM_API_KEY: z.string().optional(),

  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  WORKER_ID: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  FFMPEG_PATH: z.string().optional(),
  FFPROBE_PATH: z.string().optional(),
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

/** Read a variable that a specific feature needs; fails with a clear message when absent. */
export function requireEnv(key: keyof Env): string {
  const value = env()[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${key} is not set (see .env.example)`);
  }
  return value;
}
