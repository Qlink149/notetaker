import mongoose, { Schema, type Types } from 'mongoose';

// Multi-phone capture (prototype): a session groups several phones recording the same meeting.

export type SessionState = 'lobby' | 'recording' | 'stopped' | 'processing' | 'done' | 'failed';
export type ParticipantStatus = 'joined' | 'ready' | 'recording' | 'uploaded' | 'failed';

export interface SessionDoc {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  /** Six characters people can type; unique among live sessions. */
  code: string;
  title: string;
  state: SessionState;
  /** Server clock when the host pressed Start. */
  startedAt: Date | null;
  stoppedAt: Date | null;
  /** The meeting made from the mix once the session is finished. */
  meetingId: Types.ObjectId | null;
  /** Cloudinary folder holding every phone's parts. */
  folder: string;
  error: string | null;
  /** What the alignment found, per participant name; shown in the UI and the handover. */
  report: Record<string, unknown> | null;
  createdAt: Date;
}
const sessionSchema = new Schema<SessionDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    code: { type: String, required: true, unique: true },
    title: { type: String, default: 'Group recording' },
    state: { type: String, default: 'lobby' },
    startedAt: { type: Date, default: null },
    stoppedAt: { type: Date, default: null },
    meetingId: { type: Schema.Types.ObjectId, default: null },
    folder: { type: String, required: true },
    error: { type: String, default: null },
    report: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);
export const SessionModel = mongoose.model<SessionDoc>(
  'MeetingSession',
  sessionSchema,
  'meetingsessions',
);

export interface PartDoc {
  index: number;
  publicId: string;
  url: string;
  bytes: number;
  /** Index (in the phone's own 16 kHz timeline) of the part's first sample. */
  startSample: number;
}
export interface ParticipantDoc {
  _id: Types.ObjectId;
  sessionId: Types.ObjectId;
  name: string;
  deviceLabel: string;
  /** Secret the phone presents with every call; the join code alone cannot act as a participant. */
  token: string;
  /** A known person, when the host picked one from the speaker list. */
  speakerId: Types.ObjectId | null;
  status: ParticipantStatus;
  /** Latest input level (dB), for the host's meter. */
  level: number | null;
  lastSeen: Date;
  /** Server clock (ms since epoch) estimated for the phone's first recorded sample. */
  firstSampleServerMs: number | null;
  parts: PartDoc[];
}
const participantSchema = new Schema<ParticipantDoc>({
  sessionId: { type: Schema.Types.ObjectId, required: true, index: true },
  name: { type: String, required: true },
  deviceLabel: { type: String, default: '' },
  token: { type: String, required: true },
  speakerId: { type: Schema.Types.ObjectId, default: null },
  status: { type: String, default: 'joined' },
  level: { type: Number, default: null },
  lastSeen: { type: Date, default: () => new Date() },
  firstSampleServerMs: { type: Number, default: null },
  parts: { type: Schema.Types.Mixed, default: [] },
});
export const ParticipantModel = mongoose.model<ParticipantDoc>(
  'SessionParticipant',
  participantSchema,
  'sessionparticipants',
);

/** Level-matched loudness of each phone per 250 ms hop of the mixed timeline. */
export interface LoudnessDoc {
  _id: Types.ObjectId;
  sessionId: Types.ObjectId;
  participantId: Types.ObjectId;
  hopSec: number;
  db: number[];
}
const loudnessSchema = new Schema<LoudnessDoc>({
  sessionId: { type: Schema.Types.ObjectId, required: true, index: true },
  participantId: { type: Schema.Types.ObjectId, required: true },
  hopSec: Number,
  db: { type: [Number], default: [] },
});
export const LoudnessModel = mongoose.model<LoudnessDoc>(
  'SessionLoudness',
  loudnessSchema,
  'sessionloudness',
);
