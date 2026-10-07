import mongoose, { Schema, type Types } from 'mongoose';

// Phase 2 experiment collections (prefix `p2_`). Written only by scripts under src/scripts/phase2
// and the /audit routes until Stage D folds what survives into the main models.

// ---------- Raw pyannote job output (results expire 24 h after completion; DECISIONS #26) ----------
export type PyannoteKind = 'diarize' | 'identify' | 'voiceprint';

export interface P2PyannoteResponseDoc {
  _id: Types.ObjectId;
  meetingId: Types.ObjectId | null;
  kind: PyannoteKind;
  model: string;
  /** Request body as sent, minus voiceprint strings (labels kept). */
  params: Record<string, unknown>;
  /** Free-form tag to tell experiment runs apart (e.g. "stageA", "stageA-minmax"). */
  tag: string;
  jobId: string;
  status: string;
  submittedAt: Date;
  completedAt: Date | null;
  /** Complete `output` object of the job, untouched. */
  output: unknown;
  error: string | null;
  /** Env variable name of the key used; never the key or anything derived from it. */
  keyLabel: string;
}
const pyannoteResponseSchema = new Schema<P2PyannoteResponseDoc>({
  meetingId: { type: Schema.Types.ObjectId, default: null },
  kind: { type: String, enum: ['diarize', 'identify', 'voiceprint'], required: true },
  model: { type: String, required: true },
  params: { type: Schema.Types.Mixed, default: {} },
  tag: { type: String, default: '' },
  jobId: { type: String, required: true, unique: true },
  status: { type: String, required: true },
  submittedAt: { type: Date, required: true },
  completedAt: { type: Date, default: null },
  output: { type: Schema.Types.Mixed, default: null },
  error: { type: String, default: null },
  keyLabel: { type: String, required: true },
});
pyannoteResponseSchema.index({ meetingId: 1, kind: 1, model: 1, tag: 1, submittedAt: -1 });
export const P2PyannoteResponseModel = mongoose.model<P2PyannoteResponseDoc>(
  'P2PyannoteResponse',
  pyannoteResponseSchema,
  'p2_pyannote_responses',
);

// ---------- Analysis audio uploaded to pyannote's temporary media storage ----------
export interface P2MediaDoc {
  _id: string; // media:// URL
  meetingId: Types.ObjectId | null;
  /** What the file is: "meeting" (whole 16 kHz mono FLAC) or "clip". */
  kind: 'meeting' | 'clip';
  clip: { start: number; end: number } | null;
  durationSec: number;
  bytes: number;
  uploadedAt: Date;
}
const mediaSchema = new Schema<P2MediaDoc>({
  _id: { type: String },
  meetingId: { type: Schema.Types.ObjectId, default: null },
  kind: { type: String, enum: ['meeting', 'clip'], required: true },
  clip: { type: Schema.Types.Mixed, default: null },
  durationSec: Number,
  bytes: Number,
  uploadedAt: { type: Date, required: true },
});
export const P2MediaModel = mongoose.model<P2MediaDoc>('P2Media', mediaSchema, 'p2_media');

/** pyannote keeps uploads "at least 24 hours"; re-upload anything older than this. */
export const MEDIA_FRESH_MS = 20 * 3600_000;

// ---------- Join output per meeting and method (Stage B / Block 1) ----------
export interface P2JoinDoc {
  _id: Types.ObjectId;
  meetingId: Types.ObjectId;
  /** "m1" (time overlap only), "m3" (word clock only) or "joined" (per-chunk chooser). */
  method: 'm1' | 'm3' | 'joined';
  /** Turns carrying pyannote speaker ids. */
  turns: unknown[];
  /** Lines (<= 45 s) with "Speaker A…" names. */
  lines: unknown[];
  speakerMap: Record<string, string>;
  stats: Record<string, unknown>;
  createdAt: Date;
}
const joinSchema = new Schema<P2JoinDoc>({
  meetingId: { type: Schema.Types.ObjectId, required: true },
  method: { type: String, enum: ['m1', 'm3', 'joined'], required: true },
  turns: { type: [Schema.Types.Mixed], default: [] },
  lines: { type: [Schema.Types.Mixed], default: [] },
  speakerMap: { type: Schema.Types.Mixed, default: {} },
  stats: { type: Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: () => new Date() },
});
joinSchema.index({ meetingId: 1, method: 1 }, { unique: true });
export const P2JoinModel = mongoose.model<P2JoinDoc>('P2Join', joinSchema, 'p2_join_lines');

// ---------- Identify runs: every score, so thresholds can be judged ----------
export interface P2IdentityRunDoc {
  _id: Types.ObjectId;
  meetingId: Types.ObjectId;
  jobId: string;
  model: string;
  thresholds: { minScore: number; minMargin: number };
  /** Labels sent (opaque ids), mapped to person ids. */
  labelToPerson: Record<string, string>;
  /** Person id to display name at the time. */
  names: Record<string, string>;
  /** Our speaker, then person, then score (0-100). */
  matrix: Record<string, Record<string, number>>;
  /** Our speaker to outcome of the name resolution. */
  resolutions: Record<string, unknown>;
  createdAt: Date;
}
const identityRunSchema = new Schema<P2IdentityRunDoc>({
  meetingId: { type: Schema.Types.ObjectId, required: true },
  jobId: { type: String, required: true },
  model: String,
  thresholds: { type: Schema.Types.Mixed },
  labelToPerson: { type: Schema.Types.Mixed },
  names: { type: Schema.Types.Mixed },
  matrix: { type: Schema.Types.Mixed },
  resolutions: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: () => new Date() },
});
identityRunSchema.index({ meetingId: 1, createdAt: -1 });
export const P2IdentityRunModel = mongoose.model<P2IdentityRunDoc>(
  'P2IdentityRun',
  identityRunSchema,
  'p2_identity_runs',
);

// ---------- Blind audit (the only real measure of speaker accuracy) ----------
export interface AuditItem {
  id: string;
  /** Hidden from the person auditing. */
  method: 'm1' | 'm3';
  start: number;
  end: number;
  /** pyannote speaker the method gave this line. */
  diar: string;
  textRoman: string;
  textNative: string;
  /** Under 3 s: sampled as a separate stratum. */
  short: boolean;
  speaker: 'right' | 'wrong' | 'unsure' | null;
  text: 'match' | 'partly' | 'no' | null;
  answeredAt: Date | null;
}
export interface P2AuditDoc {
  _id: Types.ObjectId;
  meetingId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  /** pyannote speaker to the name typed by the auditor. */
  naming: Record<string, string>;
  /** pyannote speaker to the speaker it is the same person as. */
  sameAs: Record<string, string>;
  items: AuditItem[];
  perMethod: number;
  createdAt: Date;
}
const auditSchema = new Schema<P2AuditDoc>({
  meetingId: { type: Schema.Types.ObjectId, required: true, unique: true },
  workspaceId: { type: Schema.Types.ObjectId, required: true },
  naming: { type: Schema.Types.Mixed, default: {} },
  sameAs: { type: Schema.Types.Mixed, default: {} },
  items: { type: Schema.Types.Mixed, default: [] },
  perMethod: Number,
  createdAt: { type: Date, default: () => new Date() },
});
export const P2AuditModel = mongoose.model<P2AuditDoc>('P2Audit', auditSchema, 'p2_audits');

export const phase2Models = [
  P2AuditModel,

  P2PyannoteResponseModel,
  P2MediaModel,
  P2JoinModel,
  P2IdentityRunModel,
];
