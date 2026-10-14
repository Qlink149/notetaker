import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireEnv } from '../../config/env.js';
import { createAnalysisCache } from '../../lib/analysisCache.js';
import { ensureAnalysisFlac } from '../../pipeline/chunkAudio.js';
import { MeetingModel } from '../../models/index.js';
import {
  MEDIA_FRESH_MS,
  P2MediaModel,
  P2PyannoteResponseModel,
  type P2PyannoteResponseDoc,
  type PyannoteKind,
} from '../../models/phase2.js';
import { probe, toAnalysisFlac } from '../audio/ffmpeg.js';
import { getStorage } from '../storage/index.js';
import {
  PYANNOTE_KEY_LABEL,
  keyLabelFor,
  uploadMedia,
  waitForJob,
  type PyannoteModel,
} from './client.js';
import { trimOutput } from './output.js';

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
  // The same shared copy the pipeline stages use (built once at ingest), so a meeting's original is not fetched
  // from storage and converted again here; concurrent callers (one per speaker) wait for a single build.
  return ensureAnalysisFlac(
    { storage: getStorage(), audio: { toAnalysisFlac }, analysisCache },
    dir,
    meeting.audio.originalUrl,
  );
}

const analysisCache = createAnalysisCache();

/**
 * The name the meeting's audio is uploaded to pyannote under. Speaker analysis and voice identification both
 * use it, so the second finds the first's upload instead of sending the whole recording again. The tag changes
 * with the pyannote key in use, so a different account never reuses an address it cannot see.
 */
export function meetingMediaKey(meetingId: string): string {
  const tag = createHash('sha1').update(requireEnv(PYANNOTE_KEY_LABEL)).digest('hex').slice(0, 4);
  return `p2-${meetingId}-${tag}.flac`;
}

/** media:// URL of the meeting's analysis FLAC, uploading it again when the copy may have expired. */
export async function meetingMedia(meetingId: string): Promise<string> {
  const key = meetingMediaKey(meetingId);
  const fresh = await P2MediaModel.findOne({
    _id: `media://${key}`,
    meetingId,
    kind: 'meeting',
    uploadedAt: { $gt: new Date(Date.now() - MEDIA_FRESH_MS) },
  }).lean();
  if (fresh) return fresh._id;
  const flac = await analysisFlac(meetingId);
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
  // voiceprints may live on a second account; their jobs can only be polled with that account's key
  const account = spec.kind === 'voiceprint' ? 'voiceprint' : 'main';
  const started = await submitOrResume(spec, log);
  if ('stored' in started) return started.stored;
  const { jobId } = started;
  try {
    const job = await waitForJob(jobId, {
      account,
      onPoll: (s, ms) => log(`  ${jobId} ${s} ${Math.round(ms / 1000)}s`),
    });
    return (await P2PyannoteResponseModel.findOneAndUpdate(
      { jobId },
      {
        $set: {
          status: 'succeeded',
          output: trimOutput(job.output) ?? null,
          completedAt: new Date(),
        },
      },
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

/**
 * The first half of runJob: a stored success is returned as it is; a job submitted earlier (and not failed or
 * expired) is picked up; otherwise the job is submitted and recorded. It does not wait for the result, so a job
 * can be started early and collected later by `runJob` with the same key.
 */
export async function submitOrResume(
  spec: JobSpec,
  log = console.log,
): Promise<{ stored: P2PyannoteResponseDoc } | { jobId: string }> {
  const account = spec.kind === 'voiceprint' ? 'voiceprint' : 'main';
  const key = { meetingId: spec.meetingId, kind: spec.kind, model: spec.model, tag: spec.tag };
  const prior = await P2PyannoteResponseModel.findOne(key).sort({ submittedAt: -1 }).lean();
  if (prior?.status === 'succeeded' && prior.output) return { stored: prior };
  if (
    prior &&
    !['failed', 'canceled', 'expired'].includes(prior.status) &&
    Date.now() - prior.submittedAt.getTime() < RESULT_TTL_MS
  ) {
    log(`resume ${spec.kind} ${spec.model} ${spec.meetingId} job ${prior.jobId}`);
    return { jobId: prior.jobId };
  }
  const jobId = await spec.submit();
  await P2PyannoteResponseModel.create({
    ...key,
    params: storableParams(spec.body),
    jobId,
    status: 'submitted',
    submittedAt: new Date(),
    keyLabel: keyLabelFor(account),
  });
  log(`submitted ${spec.kind} ${spec.model} ${spec.meetingId} job ${jobId}`);
  return { jobId };
}
