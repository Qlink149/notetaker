import { z } from 'zod';

/** Job types run by the worker. Pipeline stages plus the benchmark. */
export const JobStage = z.enum([
  'ingest',
  'transcribe',
  'assemble',
  'summarise',
  'finalise',
  'benchmark',
]);
export type JobStage = z.infer<typeof JobStage>;

export const JobStatus = z.enum(['queued', 'running', 'done', 'failed']);
export type JobStatus = z.infer<typeof JobStatus>;

export const Job = z.object({
  id: z.string(),
  meetingId: z.string(),
  stage: JobStage,
  /** Chunk index for `transcribe`; unused otherwise. */
  step: z.number().nullable(),
  status: JobStatus,
  attempts: z.number(),
  maxAttempts: z.number(),
  runAfter: z.string(),
  lockedBy: z.string().nullable(),
  lockedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()).nullable(),
});
export type Job = z.infer<typeof Job>;

/** How long a running job may hold its lock before another worker may reclaim it. */
export const STAGE_LEASE_MS: Record<JobStage, number> = {
  ingest: 5 * 60_000,
  transcribe: 8 * 60_000,
  assemble: 2 * 60_000,
  summarise: 5 * 60_000,
  finalise: 2 * 60_000,
  benchmark: 20 * 60_000,
};
