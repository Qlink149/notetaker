import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeetingModel } from '../../models/index.js';
import {
  MEDIA_FRESH_MS,
  P2MediaModel,
  P2PyannoteResponseModel,
  type P2PyannoteResponseDoc,
  type PyannoteKind,
} from '../../models/phase2.js';
import { probe, toAnalysisFlac } from '../audio/ffmpeg.js';
import { cloudinaryStorage } from '../storage/cloudinary.js';
import { PYANNOTE_KEY_LABEL, uploadMedia, waitForJob, type PyannoteModel } from './client.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
/** Local cache (gitignored /scratch) for analysis FLACs and clips. */
export const scratchDir = (...parts: string[]): string => join(repoRoot, 'scratch', 'p2', ...parts);

/** 16 kHz mono FLAC of the meeting's original, cached locally; same transform as Phase 1 ingest. */
export async function analysisFlac(meetingId: string): Promise<string> {
  const dir = scratchDir(meetingId);
  const flac = join(dir, 'analysis.flac');
  if (existsSync(flac)) return flac;
  const meeting = await MeetingModel.findById(meetingId).lean();
  if (!meeting?.audio?.originalUrl) throw new Error(`meeting ${meetingId} has no original audio`);
  await mkdir(dir, { recursive: true });
  const original = join(dir, 'original');
  await cloudinaryStorage.download(meeting.audio.originalUrl, original);
  await toAnalysisFlac(original, flac);
  return flac;
}

/** media:// URL of the meeting's analysis FLAC, uploading it again when the copy may have expired. */
export async function meetingMedia(meetingId: string): Promise<string> {
  const fresh = await P2MediaModel.findOne({
    meetingId,
    kind: 'meeting',
    uploadedAt: { $gt: new Date(Date.now() - MEDIA_FRESH_MS) },
  }).lean();
  if (fresh) return fresh._id;
  const flac = await analysisFlac(meetingId);
  const key = `p2-${meetingId}.flac`;
  const url = await uploadMedia(flac, key);
  const { durationSec } = await probe(flac);
  const { size } = await stat(flac);
  await P2MediaModel.updateOne(
    { _id: url },
    {
      $set: {
        meetingId,
        kind: 'meeting',
        clip: null,
        durationSec,
        bytes: size,
        uploadedAt: new Date(),
      },
    },
    { upsert: true },
  );
  return url;
}

export interface JobSpec {
  meetingId: string | null;
  kind: PyannoteKind;
  model: PyannoteModel;
  tag: string;
  /** Body as sent; voiceprint strings are stripped before storing. */
  body: Record<string, unknown>;
  submit: () => Promise<string>;
}

function storableParams(body: Record<string, unknown>): Record<string, unknown> {
  const { voiceprints, ...rest } = body;
  return Array.isArray(voiceprints)
    ? { ...rest, voiceprints: (voiceprints as { label: string }[]).map((v) => v.label) }
    : rest;
}

const RESULT_TTL_MS = 24 * 3600_000;

/**
 * Submit (or resume) a pyannote job and store its complete output. A stored success is reused;
 * a job submitted earlier is resumed while its result can still exist, otherwise resubmitted.
 */
export async function runJob(spec: JobSpec, log = console.log): Promise<P2PyannoteResponseDoc> {
  const key = { meetingId: spec.meetingId, kind: spec.kind, model: spec.model, tag: spec.tag };
  const prior = await P2PyannoteResponseModel.findOne(key).sort({ submittedAt: -1 }).lean();
  if (prior?.status === 'succeeded' && prior.output) return prior;
  let jobId: string;
  if (
    prior &&
    !['failed', 'canceled', 'expired'].includes(prior.status) &&
    Date.now() - prior.submittedAt.getTime() < RESULT_TTL_MS
  ) {
    jobId = prior.jobId;
    log(`resume ${spec.kind} ${spec.model} ${spec.meetingId} job ${jobId}`);
  } else {
    jobId = await spec.submit();
    await P2PyannoteResponseModel.create({
      ...key,
      params: storableParams(spec.body),
      jobId,
      status: 'submitted',
      submittedAt: new Date(),
      keyLabel: PYANNOTE_KEY_LABEL,
    });
    log(`submitted ${spec.kind} ${spec.model} ${spec.meetingId} job ${jobId}`);
  }
  try {
    const job = await waitForJob(jobId, {
      onPoll: (s, ms) => log(`  ${jobId} ${s} ${Math.round(ms / 1000)}s`),
    });
    return (await P2PyannoteResponseModel.findOneAndUpdate(
      { jobId },
      { $set: { status: 'succeeded', output: job.output ?? null, completedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean())!;
  } catch (err) {
    const message = (err as Error).message;
    // A 404 on a job we stored means the result expired before we fetched it.
    const status = /\b404\b/.test(message) ? 'expired' : 'failed';
    await P2PyannoteResponseModel.updateOne({ jobId }, { $set: { status, error: message } });
    throw err;
  }
}
