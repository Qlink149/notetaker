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

export const phase2Models = [P2PyannoteResponseModel, P2MediaModel];
