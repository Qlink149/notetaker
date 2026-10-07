import mongoose, { Schema, type Model, type Types } from 'mongoose';
import {
  BenchmarkEngineName,
  ChunkStatus,
  EngineName,
  GlossaryKind,
  JobStage,
  JobStatus,
  Language,
  MeetingStatus,
  ScriptPreference,
  Stage,
  SummaryStatus,
  TurnLang,
  emptyCost,
  type ActionItem,
  type ChunkStatus as ChunkStatusT,
  type Coverage,
  type EngineName as EngineNameT,
  type GlossaryEntry,
  type JobStage as JobStageT,
  type JobStatus as JobStatusT,
  type Language as LanguageT,
  type Line,
  type MeetingCost,
  type MeetingError,
  type MeetingStatus as MeetingStatusT,
  type Segment,
  type Stage as StageT,
  type SummaryStatus as SummaryStatusT,
  type Turn,
  type WorkspaceSettings,
  type BenchmarkEngineName as BenchmarkEngineNameT,
} from '@meetingid/shared';

// Explicit document interfaces (Mongoose's inferred types make every nested field optional).

const opts = { _id: false } as const;

// ---------- Workspace ----------
export interface WorkspaceDoc {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  /** scrypt hash of the shared access code (`salt:hash`, hex). */
  accessCodeHash: string;
  /** Bumped on access-code rotation; JWTs carrying an older version are rejected. */
  tokenVersion: number;
  settings: WorkspaceSettings;
  createdAt: Date;
  updatedAt: Date;
}
const workspaceSchema = new Schema<WorkspaceDoc>(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    accessCodeHash: { type: String, required: true },
    tokenVersion: { type: Number, default: 1 },
    settings: {
      engine: { type: String, enum: EngineName.options, default: 'gemini' },
      languages: { type: [String], enum: Language.options, default: ['hi', 'gu', 'en'] },
      scriptPreference: { type: String, enum: ScriptPreference.options, default: 'roman' },
      summaryModel: { type: String, default: 'claude-haiku-4-5-20251001' },
    },
  },
  { timestamps: true },
);
export const WorkspaceModel = mongoose.model<WorkspaceDoc>('Workspace', workspaceSchema);

// ---------- Glossary ----------
export interface GlossaryDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  entries: GlossaryEntry[];
}
const glossarySchema = new Schema<GlossaryDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, unique: true },
    entries: {
      type: [
        new Schema(
          {
            term: { type: String, required: true },
            kind: { type: String, enum: GlossaryKind.options, required: true },
            aliases: { type: [String], default: [] },
            note: { type: String },
          },
          opts,
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);
export const GlossaryModel = mongoose.model<GlossaryDoc>('Glossary', glossarySchema);

// ---------- Meeting (small, polled) ----------
export interface MeetingAudioDoc {
  originalUrl: string;
  originalPublicId: string;
  playbackUrl: string | null;
  analysisUrl: string | null;
  analysisPublicId: string | null;
}
export interface MeetingDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  title: string;
  date: Date;
  durationSec: number | null;
  status: MeetingStatusT;
  stage: StageT;
  progress: { chunksTotal: number; chunksDone: number };
  engine: EngineNameT;
  languages: LanguageT[];
  expectedParticipants: number | null;
  audio: MeetingAudioDoc;
  coverage: Coverage | null;
  participants: string[];
  unknownCount: number;
  summaryStatus: SummaryStatusT;
  summary: string | null;
  actionItems: ActionItem[];
  error: MeetingError | null;
  cost: MeetingCost;
  createdAt: Date;
  updatedAt: Date;
}
const meetingSchema = new Schema<MeetingDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    title: { type: String, required: true },
    date: { type: Date, default: () => new Date() },
    durationSec: { type: Number, default: null },
    status: { type: String, enum: MeetingStatus.options, default: 'uploaded' },
    stage: { type: String, enum: Stage.options, default: 'ingest' },
    progress: {
      chunksTotal: { type: Number, default: 0 },
      chunksDone: { type: Number, default: 0 },
    },
    engine: { type: String, enum: EngineName.options, default: 'gemini' },
    languages: { type: [String], enum: Language.options, default: [] },
    expectedParticipants: { type: Number, default: null },
    audio: {
      originalUrl: { type: String, required: true },
      originalPublicId: { type: String, required: true },
      playbackUrl: { type: String, default: null },
      analysisUrl: { type: String, default: null },
      analysisPublicId: { type: String, default: null },
    },
    coverage: {
      type: new Schema({ speechSec: Number, coveredSec: Number, ratio: Number }, opts),
      default: null,
    },
    participants: { type: [String], default: [] },
    unknownCount: { type: Number, default: 0 },
    summaryStatus: { type: String, enum: SummaryStatus.options, default: 'pending' },
    summary: { type: String, default: null },
    actionItems: { type: [new Schema({ speakerName: String, text: String }, opts)], default: [] },
    error: {
      type: new Schema({ stage: String, message: String, retryable: Boolean }, opts),
      default: null,
    },
    cost: {
      type: new Schema(
        {
          usd: { type: Number, default: 0 },
          geminiInputTokens: { type: Number, default: 0 },
          geminiOutputTokens: { type: Number, default: 0 },
          deepgramSec: { type: Number, default: 0 },
          claudeInputTokens: { type: Number, default: 0 },
          claudeOutputTokens: { type: Number, default: 0 },
        },
        opts,
      ),
      default: emptyCost,
    },
  },
  { timestamps: true },
);
meetingSchema.index({ workspaceId: 1, createdAt: -1 });
export const MeetingModel = mongoose.model<MeetingDoc>('Meeting', meetingSchema);

// ---------- MeetingData (large, fetched once) ----------
const turnSchema = new Schema(
  {
    speaker: String,
    start: Number,
    end: Number,
    textNative: String,
    textRoman: String,
    lang: { type: String, enum: TurnLang.options },
    timeEstimated: { type: Boolean, default: undefined },
    timeScaled: { type: Boolean, default: undefined },
    romanFix: { type: String, enum: ['transliterated', 'unrepaired'], default: undefined },
  },
  opts,
);
const lineSchema = new Schema(
  {
    speakerName: String,
    start: Number,
    end: Number,
    textNative: String,
    textRoman: String,
    timeEstimated: { type: Boolean, default: undefined },
    timeScaled: { type: Boolean, default: undefined },
    romanFix: { type: String, enum: ['transliterated', 'unrepaired'], default: undefined },
  },
  opts,
);

export interface ChunkDoc {
  index: number;
  startSec: number;
  endSec: number;
  audioUrl: string | null;
  audioPublicId: string | null;
  geminiFileUri: string | null;
  geminiFileName: string | null;
  /** Which Gemini key holds the uploaded file (files are per project). */
  geminiKeyId: string | null;
  uploadedAt: Date | null;
  /** Model that produced rawTurns. */
  model: string | null;
  status: ChunkStatusT;
  attempts: number;
  parent: number | null;
  rawTurns: Turn[];
  /** EngineResponse that rawTurns were built from. */
  responseId: Types.ObjectId | null;
}
export interface MeetingDataDoc {
  _id: Types.ObjectId;
  meetingId: Types.ObjectId;
  chunks: ChunkDoc[];
  turns: Turn[];
  lines: Line[];
  speechSegments: Segment[];
  speakerMap: Record<string, string>;
  /** Gap-fill calls: transcripts of speech the chunk calls missed (labels are gap-local). */
  gapFills: GapFillDoc[];
  /** Phase 2: one card per pyannote speaker (who it is, how sure, sample clips). */
  speakerCards: SpeakerCardDoc[];
  /** Where the speaker labels came from; "text-fallback" is Phase 1's text linker (no pyannote). */
  speakerSource: 'pyannote' | 'text-fallback';
  /** Phase 1's turns, lines and speaker map before the pyannote join replaced them. */
  phase1: { turns: Turn[]; lines: Line[]; speakerMap: Record<string, string> } | null;
}
/** Who one pyannote speaker is in one meeting. */
export interface SpeakerCardDoc {
  /** pyannote speaker id, e.g. SPEAKER_02. */
  diar: string;
  /** Anonymous per-meeting label ("Speaker A"), by speaking time. */
  label: string;
  /** Person (Speaker document) this voice belongs to. */
  personId: string | null;
  speakerSec: number;
  /** Cross-meeting voiceprint match that linked this voice to an earlier person. */
  match: { personId: string; name: string; score: number; margin: number } | null;
  /** Closest known person when the match was rejected. */
  candidate: { name: string; score: number; status: string } | null;
  /** solid = confident voiceprint match or confirmed by a person; review = needs a look; new = first time heard; manual = set by hand. */
  status: 'solid' | 'review' | 'new' | 'manual';
  /** Playable samples in the meeting audio. */
  clips: { start: number; end: number; quality: number | null }[];
}
export interface GapFillDoc {
  start: number;
  end: number;
  cutStart: number;
  cutEnd: number;
  status: 'done' | 'failed';
  model: string | null;
  error: string | null;
  turns: Turn[];
  /** EngineResponse of this call (null when no reply arrived). */
  responseId: Types.ObjectId | null;
}
const meetingDataSchema = new Schema<MeetingDataDoc>(
  {
    meetingId: { type: Schema.Types.ObjectId, required: true, unique: true },
    chunks: {
      type: [
        new Schema(
          {
            index: { type: Number, required: true },
            startSec: { type: Number, required: true },
            endSec: { type: Number, required: true },
            audioUrl: { type: String, default: null },
            audioPublicId: { type: String, default: null },
            geminiFileUri: { type: String, default: null },
            geminiFileName: { type: String, default: null },
            geminiKeyId: { type: String, default: null },
            uploadedAt: { type: Date, default: null },
            model: { type: String, default: null },
            status: { type: String, enum: ChunkStatus.options, default: 'pending' },
            attempts: { type: Number, default: 0 },
            parent: { type: Number, default: null },
            rawTurns: { type: [turnSchema], default: [] },
            responseId: { type: Schema.Types.ObjectId, default: null },
          },
          opts,
        ),
      ],
      default: [],
    },
    turns: { type: [turnSchema], default: [] },
    lines: { type: [lineSchema], default: [] },
    speechSegments: { type: [new Schema({ start: Number, end: Number }, opts)], default: [] },
    speakerMap: { type: Schema.Types.Mixed, default: {} },
    speakerCards: { type: Schema.Types.Mixed, default: [] },
    speakerSource: { type: String, enum: ['pyannote', 'text-fallback'], default: 'text-fallback' },
    phase1: { type: Schema.Types.Mixed, default: null },
    gapFills: {
      type: [
        new Schema(
          {
            start: Number,
            end: Number,
            cutStart: Number,
            cutEnd: Number,
            status: { type: String, enum: ['done', 'failed'] },
            model: { type: String, default: null },
            error: { type: String, default: null },
            turns: { type: [turnSchema], default: [] },
            responseId: { type: Schema.Types.ObjectId, default: null },
          },
          opts,
        ),
      ],
      default: [],
    },
  },
  { timestamps: true, minimize: false },
);
export const MeetingDataModel = mongoose.model<MeetingDataDoc>(
  'MeetingData',
  meetingDataSchema,
  'meetingdata',
);

// ---------- Job (the queue) ----------
export interface JobDoc {
  _id: Types.ObjectId;
  meetingId: Types.ObjectId;
  stage: JobStageT;
  /** Chunk index for `transcribe`. */
  step: number | null;
  status: JobStatusT;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  lockedBy: string | null;
  lockedAt: Date | null;
  lastError: string | null;
  payload: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}
const jobSchema = new Schema<JobDoc>(
  {
    meetingId: { type: Schema.Types.ObjectId, required: true },
    stage: { type: String, enum: JobStage.options, required: true },
    step: { type: Number, default: null },
    status: { type: String, enum: JobStatus.options, default: 'queued' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    runAfter: { type: Date, default: () => new Date() },
    lockedBy: { type: String, default: null },
    lockedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    payload: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);
jobSchema.index({ status: 1, runAfter: 1 });
jobSchema.index({ meetingId: 1, stage: 1, step: 1 });
export const JobModel = mongoose.model<JobDoc>('Job', jobSchema);

// ---------- Worker heartbeat ----------
export interface HeartbeatDoc {
  _id: string;
  lastHeartbeat: Date;
  startedAt: Date;
}
const heartbeatSchema = new Schema<HeartbeatDoc>({
  _id: { type: String },
  lastHeartbeat: { type: Date, required: true },
  startedAt: { type: Date, required: true },
});
export const HeartbeatModel = mongoose.model<HeartbeatDoc>('WorkerHeartbeat', heartbeatSchema);

// ---------- Speaker (Phase 2 fills voiceprints) ----------
export interface VoiceprintDoc {
  /** Phase 1 enrolments stored the voiceprint string here; Phase 2 uses `voiceprint`. */
  id: string;
  source: 'enrolment' | 'meeting';
  audioUrl: string;
  createdAt: Date;
  /** pyannote voiceprint string (kept until the person is deleted; pyannote does not store it). */
  voiceprint?: string;
  /** pyannote model that made it; voiceprints only work with the same model. */
  model?: string;
  meetingId?: Types.ObjectId | null;
  clip?: { start: number; end: number } | null;
  /** Mean turn confidence (0–100) of the clip. */
  quality?: number | null;
}
export interface SpeakerDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  /** Other names for the same person. */
  aliases: string[];
  /** True until a human types a real name; the name is then a placeholder like "Speaker A (Meeting 21/9)". */
  anonymous: boolean;
  /** Where the person was first heard. */
  origin: { meetingId: Types.ObjectId; diar: string } | null;
  voiceprints: VoiceprintDoc[];
  createdAt: Date;
}
const speakerSchema = new Schema<SpeakerDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    aliases: { type: [String], default: [] },
    anonymous: { type: Boolean, default: false },
    origin: { type: Schema.Types.Mixed, default: null },
    voiceprints: {
      type: [
        new Schema(
          {
            id: { type: String, required: true },
            source: { type: String, enum: ['enrolment', 'meeting'], required: true },
            audioUrl: { type: String, default: '' },
            createdAt: { type: Date, default: () => new Date() },
            voiceprint: { type: String },
            model: { type: String },
            meetingId: { type: Schema.Types.ObjectId, default: null },
            clip: { type: Schema.Types.Mixed, default: null },
            quality: { type: Number, default: null },
          },
          opts,
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);
speakerSchema.index({ workspaceId: 1, name: 1 }, { unique: true });
export const SpeakerModel = mongoose.model<SpeakerDoc>('Speaker', speakerSchema);

// ---------- Benchmark ----------
export interface EvalSetDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  items: { meetingId: Types.ObjectId; referenceLines?: Line[] }[];
  createdAt: Date;
}
const evalSetSchema = new Schema<EvalSetDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    items: {
      type: [
        new Schema(
          {
            meetingId: Schema.Types.ObjectId,
            referenceLines: { type: [lineSchema], default: undefined },
          },
          opts,
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);
export const EvalSetModel = mongoose.model<EvalSetDoc>('EvalSet', evalSetSchema);

export interface EvalResultDoc {
  meetingId: Types.ObjectId;
  engine: BenchmarkEngineNameT;
  model: string;
  status: 'pending' | 'done' | 'failed';
  error: string | null;
  coverage: number | null;
  turns: number;
  words: number;
  durationMs: number;
  costTokens: { input: number; output: number; audioSec: number };
  transcriptLines: Line[];
}
export interface EvalRunDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  evalSetId: Types.ObjectId | null;
  engines: BenchmarkEngineNameT[];
  meetingIds: Types.ObjectId[];
  status: 'running' | 'done';
  results: EvalResultDoc[];
  createdAt: Date;
}
const evalRunSchema = new Schema<EvalRunDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    evalSetId: { type: Schema.Types.ObjectId, default: null },
    engines: { type: [String], default: [] },
    meetingIds: { type: [Schema.Types.ObjectId], default: [] },
    status: { type: String, enum: ['running', 'done'], default: 'running' },
    results: {
      type: [
        new Schema(
          {
            meetingId: { type: Schema.Types.ObjectId, required: true },
            engine: { type: String, enum: BenchmarkEngineName.options, required: true },
            model: { type: String, default: '' },
            status: { type: String, enum: ['pending', 'done', 'failed'], default: 'pending' },
            error: { type: String, default: null },
            coverage: { type: Number, default: null },
            turns: { type: Number, default: 0 },
            words: { type: Number, default: 0 },
            durationMs: { type: Number, default: 0 },
            costTokens: {
              input: { type: Number, default: 0 },
              output: { type: Number, default: 0 },
              audioSec: { type: Number, default: 0 },
            },
            transcriptLines: { type: [lineSchema], default: [] },
          },
          opts,
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);
export const EvalRunModel = mongoose.model<EvalRunDoc>('EvalRun', evalRunSchema);

// ---------- Gemini key quota (free-tier daily limits) ----------
export interface QuotaDoc {
  /** `<keyId>:<model>` */
  _id: string;
  keyLabel: string;
  model: string;
  exhaustedUntil: Date;
}
const quotaSchema = new Schema<QuotaDoc>({
  _id: { type: String },
  keyLabel: String,
  model: String,
  exhaustedUntil: { type: Date, required: true },
});
export const QuotaModel = mongoose.model<QuotaDoc>('GeminiQuota', quotaSchema, 'geminiquotas');

// ---------- Spend ledger (hard cap) ----------
export interface SpendDoc {
  _id: string;
  usd: number;
  byProvider: Record<string, number>;
  updatedAt: Date;
}
const spendSchema = new Schema<SpendDoc>({
  _id: { type: String },
  usd: { type: Number, default: 0 },
  byProvider: { type: Schema.Types.Mixed, default: {} },
  updatedAt: { type: Date, default: () => new Date() },
});
export const SpendModel = mongoose.model<SpendDoc>('Spend', spendSchema, 'spend');

// ---------- Summary handoff (testing: an external agent answers instead of the API) ----------
export interface HandoffDoc {
  /** `<meetingId>:<hash of the prompt>` */
  _id: string;
  meetingId: Types.ObjectId;
  model: string;
  system: string;
  user: string;
  status: 'pending' | 'answered';
  response: string | null;
  /** Replies that failed validation (each one re-opens the request). */
  rejections: number;
  lastError: string | null;
  createdAt: Date;
  answeredAt: Date | null;
}
const handoffSchema = new Schema<HandoffDoc>({
  _id: { type: String },
  meetingId: { type: Schema.Types.ObjectId, required: true },
  model: String,
  system: String,
  user: String,
  status: { type: String, enum: ['pending', 'answered'], default: 'pending' },
  response: { type: String, default: null },
  rejections: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  createdAt: { type: Date, default: () => new Date() },
  answeredAt: { type: Date, default: null },
});
export const HandoffModel = mongoose.model<HandoffDoc>(
  'SummaryHandoff',
  handoffSchema,
  'summaryhandoffs',
);

// ---------- Engine responses (untouched replies, one per call) ----------
export interface EngineResponseDoc {
  _id: Types.ObjectId;
  meetingId: Types.ObjectId;
  kind: 'chunk' | 'gapfill' | 'benchmark' | 'words';
  /** Chunk index for kind "chunk" and "benchmark"; null for gap fills. */
  chunkIndex: number | null;
  /** Absolute position of the audio sent; engine times are relative to startSec. */
  startSec: number;
  endSec: number;
  engine: string;
  model: string;
  promptVersion: string;
  promptHash: string;
  prompt: string;
  userText: string;
  status: string;
  text: string | null;
  response: unknown;
  usage: { inputTokens: number; outputTokens: number; audioSec: number };
  /** Env variable name of the key used (e.g. GEMINI_API_KEY1); never the key or a hash of it. */
  keyLabel: string | null;
  /** Why the reply was not used (invalid JSON, truncated, …); null when it was accepted. */
  error: string | null;
  receivedAt: Date;
}
const engineResponseSchema = new Schema<EngineResponseDoc>({
  meetingId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ['chunk', 'gapfill', 'benchmark', 'words'], required: true },
  chunkIndex: { type: Number, default: null },
  startSec: Number,
  endSec: Number,
  engine: String,
  model: String,
  promptVersion: String,
  promptHash: String,
  prompt: String,
  userText: String,
  status: String,
  text: { type: String, default: null },
  response: { type: Schema.Types.Mixed, default: null },
  usage: { inputTokens: Number, outputTokens: Number, audioSec: Number },
  keyLabel: { type: String, default: null },
  error: { type: String, default: null },
  receivedAt: Date,
});
engineResponseSchema.index({ meetingId: 1, kind: 1, chunkIndex: 1, receivedAt: 1 });
export const EngineResponseModel = mongoose.model<EngineResponseDoc>(
  'EngineResponse',
  engineResponseSchema,
  'engineresponses',
);

export const allModels: Model<never>[] = [
  WorkspaceModel,
  GlossaryModel,
  MeetingModel,
  MeetingDataModel,
  JobModel,
  HeartbeatModel,
  SpeakerModel,
  EvalSetModel,
  EvalRunModel,
  QuotaModel,
  SpendModel,
  HandoffModel,
  EngineResponseModel,
] as unknown as Model<never>[];
