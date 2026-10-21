import { z } from 'zod';
import { BenchmarkEngineName, EngineName, Language, Line, RetryableStage } from './meeting.js';

/** Request bodies validated by the API and sent by the web client. */

export const LoginBody = z.object({ code: z.string().min(1).max(200) });
export type LoginBody = z.infer<typeof LoginBody>;

/** Most files one meeting can be uploaded in. */
export const MAX_AUDIO_PARTS = 5;
export const UploadedPart = z.object({
  publicId: z.string().min(1),
  url: z.string().url(),
  fileName: z.string().max(200).optional(),
});
export type UploadedPart = z.infer<typeof UploadedPart>;

/** Sign one more upload into an existing meeting folder (files 2..n of a meeting, or a continuation). */
export const UploadSignBody = z.object({
  meetingId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
});
export type UploadSignBody = z.infer<typeof UploadSignBody>;

export const CreateMeetingBody = z.object({
  meetingId: z.string().regex(/^[a-f0-9]{24}$/),
  title: z.string().trim().min(1).max(200),
  /** The first (or only) file. */
  publicId: z.string().min(1),
  url: z.string().url(),
  /** A meeting recorded in several files, in order (the first is also `publicId`/`url`). */
  parts: z.array(UploadedPart).min(2).max(MAX_AUDIO_PARTS).optional(),
  languages: z.array(Language).min(1).optional(),
  engine: EngineName.optional(),
  expectedParticipants: z.number().int().min(1).max(50).nullable().optional(),
  date: z.string().datetime().optional(),
  /** One of the workspace's folders (Jolto, Internal…); none when left out. */
  folder: z.string().trim().min(1).max(60).nullable().optional(),
});
export type CreateMeetingBody = z.infer<typeof CreateMeetingBody>;

export const PatchMeetingBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    folder: z.string().trim().min(1).max(60).nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');
export type PatchMeetingBody = z.infer<typeof PatchMeetingBody>;

/** Most files one meeting can hold in all, continuations included. */
export const MAX_MEETING_PARTS = 10;

/** Recordings added to the end of an existing meeting (a continuation recorded later). */
export const AddPartsBody = z.object({
  parts: z.array(UploadedPart).min(1).max(MAX_AUDIO_PARTS),
});
export type AddPartsBody = z.infer<typeof AddPartsBody>;

export const RetryBody = z.object({ stage: RetryableStage });
export type RetryBody = z.infer<typeof RetryBody>;

export const SummariseBody = z.object({ force: z.boolean().default(false) });
export type SummariseBody = z.infer<typeof SummariseBody>;

export const UploadSignResponse = z.union([
  // signed form POST to Cloudinary
  z.object({
    meetingId: z.string(),
    provider: z.literal('cloudinary').optional(),
    cloudName: z.string(),
    apiKey: z.string(),
    folder: z.string(),
    timestamp: z.number(),
    signature: z.string(),
    uploadUrl: z.string(),
  }),
  // presigned PUT to private (S3-compatible) storage
  z.object({
    meetingId: z.string(),
    provider: z.literal('b2'),
    method: z.literal('PUT'),
    uploadUrl: z.string(),
    folder: z.string(),
    publicId: z.string(),
    url: z.string(),
  }),
]);
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

/** Folders a workspace starts with (client request, 20 Oct: "Jolto folder… internal… consultant"). */
export const DEFAULT_FOLDERS = ['Jolto', 'Internal', 'Consultant'] as const;

/** The workspace's folders for meetings. */
export const FoldersBody = z.object({
  folders: z.array(z.string().trim().min(1).max(60)).max(30),
});
export type FoldersBody = z.infer<typeof FoldersBody>;

/** Where a meeting was saved in Google Drive. */
export const MeetingDrive = z.object({
  fileId: z.string(),
  url: z.string(),
  folder: z.string().nullable(),
  savedAt: z.string(),
});
export type MeetingDrive = z.infer<typeof MeetingDrive>;

/** The workspace's Google Drive connection, as the app shows it. */
export const DriveStatus = z.object({
  /** The server has a Google OAuth client set up. */
  available: z.boolean(),
  connected: z.boolean(),
  email: z.string().nullable(),
});
export type DriveStatus = z.infer<typeof DriveStatus>;
