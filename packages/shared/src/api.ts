import { z } from 'zod';
import { BenchmarkEngineName, EngineName, Language, Line, RetryableStage } from './meeting.js';

/** Request bodies validated by the API and sent by the web client. */

export const LoginBody = z.object({ code: z.string().min(1).max(200) });
export type LoginBody = z.infer<typeof LoginBody>;

export const CreateMeetingBody = z.object({
  meetingId: z.string().regex(/^[a-f0-9]{24}$/),
  title: z.string().trim().min(1).max(200),
  publicId: z.string().min(1),
  url: z.string().url(),
  languages: z.array(Language).min(1).optional(),
  engine: EngineName.optional(),
  expectedParticipants: z.number().int().min(1).max(50).nullable().optional(),
  date: z.string().datetime().optional(),
});
export type CreateMeetingBody = z.infer<typeof CreateMeetingBody>;

export const PatchMeetingBody = z.object({ title: z.string().trim().min(1).max(200) });
export type PatchMeetingBody = z.infer<typeof PatchMeetingBody>;

export const RetryBody = z.object({ stage: RetryableStage });
export type RetryBody = z.infer<typeof RetryBody>;

export const SummariseBody = z.object({ force: z.boolean().default(false) });
export type SummariseBody = z.infer<typeof SummariseBody>;

export const UploadSignResponse = z.object({
  meetingId: z.string(),
  cloudName: z.string(),
  apiKey: z.string(),
  folder: z.string(),
  timestamp: z.number(),
  signature: z.string(),
  uploadUrl: z.string(),
});
export type UploadSignResponse = z.infer<typeof UploadSignResponse>;

export const BenchmarkRunBody = z.object({
  meetingIds: z.array(z.string()).min(1).max(10),
  engines: z.array(BenchmarkEngineName).min(1),
  evalSetName: z.string().max(100).optional(),
});
export type BenchmarkRunBody = z.infer<typeof BenchmarkRunBody>;

export const EvalResult = z.object({
  meetingId: z.string(),
  engine: BenchmarkEngineName,
  model: z.string(),
  status: z.enum(['pending', 'done', 'failed']),
  error: z.string().nullable(),
  coverage: z.number().nullable(),
  turns: z.number(),
  words: z.number(),
  durationMs: z.number(),
  costTokens: z.object({ input: z.number(), output: z.number(), audioSec: z.number() }),
  transcriptLines: z.array(Line),
});
export type EvalResult = z.infer<typeof EvalResult>;

export const EvalRun = z.object({
  id: z.string(),
  workspaceId: z.string(),
  evalSetId: z.string().nullable(),
  engines: z.array(BenchmarkEngineName),
  meetingIds: z.array(z.string()),
  status: z.enum(['running', 'done']),
  results: z.array(EvalResult),
  createdAt: z.string(),
});
export type EvalRun = z.infer<typeof EvalRun>;

export const PromoteEvalSetBody = z.object({
  name: z.string().trim().min(1).max(100),
  meetingIds: z.array(z.string()).min(1),
});
export type PromoteEvalSetBody = z.infer<typeof PromoteEvalSetBody>;
