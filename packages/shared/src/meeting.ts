import { z } from 'zod';

export const Language = z.enum(['hi', 'gu', 'en']);
export type Language = z.infer<typeof Language>;

export const TurnLang = z.enum(['hi', 'gu', 'en', 'mixed']);
export type TurnLang = z.infer<typeof TurnLang>;

export const EngineName = z.enum(['gemini', 'deepgram']);
export type EngineName = z.infer<typeof EngineName>;

/** Engines the benchmark may run; a superset of the production engines. */
export const BenchmarkEngineName = z.enum(['gemini', 'deepgram', 'gemini-transcribe', 'sarvam']);
export type BenchmarkEngineName = z.infer<typeof BenchmarkEngineName>;

export const MeetingStatus = z.enum(['uploaded', 'processing', 'partial', 'completed', 'failed']);
export type MeetingStatus = z.infer<typeof MeetingStatus>;

/** Pipeline stages, in execution order. `done` is terminal. */
export const Stage = z.enum(['ingest', 'transcribe', 'assemble', 'summarise', 'finalise', 'done']);
export type Stage = z.infer<typeof Stage>;

/** Stages a user may re-queue from the UI or the API. */
export const RetryableStage = z.enum(['ingest', 'transcribe', 'assemble', 'summarise', 'finalise']);
export type RetryableStage = z.infer<typeof RetryableStage>;

export const SummaryStatus = z.enum(['pending', 'completed', 'failed', 'skipped_low_coverage']);
export type SummaryStatus = z.infer<typeof SummaryStatus>;

/** One speaker utterance, as produced by an engine and re-based to absolute meeting time. */
export const Turn = z.object({
  speaker: z.string(),
  start: z.number(),
  end: z.number(),
  textNative: z.string(),
  textRoman: z.string(),
  lang: TurnLang,
  /** Start or end was invented, interpolated or clamped rather than taken from the engine. */
  timeEstimated: z.boolean().optional(),
  /** Engine times were corrected by a linear rescale (minute.second repair, overshoot, seam drift). */
  timeScaled: z.boolean().optional(),
});
export type Turn = z.infer<typeof Turn>;

/** What the UI renders: consecutive turns of one speaker merged up to a length cap. */
export const Line = z.object({
  speakerName: z.string(),
  start: z.number(),
  end: z.number(),
  textNative: z.string(),
  textRoman: z.string(),
  /** Start or end was invented, interpolated or clamped rather than taken from the engine. */
  timeEstimated: z.boolean().optional(),
  /** Engine times were corrected by a linear rescale (minute.second repair, overshoot, seam drift). */
  timeScaled: z.boolean().optional(),
});
export type Line = z.infer<typeof Line>;

export const Segment = z.object({ start: z.number(), end: z.number() });
export type Segment = z.infer<typeof Segment>;

export const Coverage = z.object({
  speechSec: z.number(),
  coveredSec: z.number(),
  ratio: z.number(),
});
export type Coverage = z.infer<typeof Coverage>;

export const ActionItem = z.object({ speakerName: z.string(), text: z.string() });
export type ActionItem = z.infer<typeof ActionItem>;

export const MeetingAudio = z.object({
  originalUrl: z.string(),
  originalPublicId: z.string(),
  playbackUrl: z.string().nullable(),
  analysisUrl: z.string().nullable(),
  analysisPublicId: z.string().nullable(),
});
export type MeetingAudio = z.infer<typeof MeetingAudio>;

export const MeetingCost = z.object({
  /** Estimated USD at published paid-tier prices (free-tier usage is not billed). */
  usd: z.number(),
  geminiInputTokens: z.number(),
  geminiOutputTokens: z.number(),
  deepgramSec: z.number(),
  claudeInputTokens: z.number(),
  claudeOutputTokens: z.number(),
});
export type MeetingCost = z.infer<typeof MeetingCost>;

export const emptyCost = (): MeetingCost => ({
  usd: 0,
  geminiInputTokens: 0,
  geminiOutputTokens: 0,
  deepgramSec: 0,
  claudeInputTokens: 0,
  claudeOutputTokens: 0,
});

export const MeetingError = z.object({
  stage: Stage,
  message: z.string(),
  retryable: z.boolean(),
});
export type MeetingError = z.infer<typeof MeetingError>;

/** The small, frequently polled meeting record. Never holds per-word or per-turn data. */
export const Meeting = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  date: z.string(),
  durationSec: z.number().nullable(),
  status: MeetingStatus,
  stage: Stage,
  progress: z.object({ chunksTotal: z.number(), chunksDone: z.number() }),
  engine: EngineName,
  languages: z.array(Language),
  expectedParticipants: z.number().nullable(),
  audio: MeetingAudio,
  coverage: Coverage.nullable(),
  participants: z.array(z.string()),
  unknownCount: z.number(),
  summaryStatus: SummaryStatus,
  summary: z.string().nullable(),
  actionItems: z.array(ActionItem),
  error: MeetingError.nullable(),
  cost: MeetingCost,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Meeting = z.infer<typeof Meeting>;

export const ChunkStatus = z.enum(['pending', 'done', 'failed', 'superseded']);
export type ChunkStatus = z.infer<typeof ChunkStatus>;

export const ChunkRecord = z.object({
  index: z.number(),
  startSec: z.number(),
  endSec: z.number(),
  /** 16 kHz mono FLAC of just this chunk, stored as a raw Cloudinary asset. */
  audioUrl: z.string().nullable(),
  audioPublicId: z.string().nullable(),
  geminiFileUri: z.string().nullable(),
  geminiFileName: z.string().nullable(),
  geminiKeyId: z.string().nullable(),
  uploadedAt: z.string().nullable(),
  model: z.string().nullable(),
  status: ChunkStatus,
  attempts: z.number(),
  /** Index of the chunk this one was split from, if any. */
  parent: z.number().nullable(),
  rawTurns: z.array(Turn),
});
export type ChunkRecord = z.infer<typeof ChunkRecord>;

/** The large per-meeting payload, fetched once by the UI. */
export const MeetingData = z.object({
  meetingId: z.string(),
  chunks: z.array(ChunkRecord),
  turns: z.array(Turn),
  lines: z.array(Line),
  speechSegments: z.array(Segment),
  speakerMap: z.record(z.string(), z.string()),
});
export type MeetingData = z.infer<typeof MeetingData>;

/** Public view of MeetingData returned by `GET /meetings/:id/data` (no raw chunk turns). */
export const MeetingDataView = MeetingData.pick({
  meetingId: true,
  turns: true,
  lines: true,
  speakerMap: true,
}).extend({ coverage: Coverage.nullable() });
export type MeetingDataView = z.infer<typeof MeetingDataView>;
