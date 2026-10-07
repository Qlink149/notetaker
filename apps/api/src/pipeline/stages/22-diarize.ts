import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { EngineResponseModel, MeetingDataModel, type MeetingDoc } from '../../models/index.js';
import { P2MediaModel, P2PyannoteResponseModel } from '../../models/phase2.js';
import { deepgramWordClock } from '../../services/engines/deepgram.js';
import {
  PYANNOTE_KEY_LABEL,
  PyannoteError,
  diarizeBody,
  getJob,
  submitDiarize,
  uploadMedia,
  type PyannoteModel,
} from '../../services/pyannote/client.js';
import { ensureAnalysisFlac } from '../chunkAudio.js';
import type { StageContext, StageHandler } from '../context.js';
import { RetryableError } from '../errors.js';
import { loadMeeting } from '../meetings.js';
import { enqueue } from '../queue.js';
import { maybeAdvanceToAssemble } from './20-transcribe.js';

/** The pyannote model the pipeline is pinned to (demo build decision 1; DECISIONS #26). */
export const PIPELINE_MODEL: PyannoteModel = 'precision-2';
export const PIPELINE_TAG = 'pipeline';
/** pyannote deletes a job's result 24 h after it completes. */
const RESULT_TTL_MS = 24 * 3600_000;
const POLL_MS = 15_000;
const TERMINAL = new Set(['failed', 'canceled', 'expired']);

async function setState(
  meetingId: Types.ObjectId,
  state: 'pending' | 'done' | 'fallback' | 'off',
  jobId: string | null = null,
  reason: string | null = null,
): Promise<void> {
  await MeetingDataModel.updateOne({ meetingId }, { $set: { diarize: { state, jobId, reason } } });
}

/** Queue the speaker stage next to transcription; `off` when the pipeline is text-only. */
export async function startDiarization(
  meeting: Pick<MeetingDoc, '_id'>,
  speakerSource: 'pyannote' | 'text',
): Promise<void> {
  if (speakerSource !== 'pyannote') {
    await setState(meeting._id, 'off', null, 'SPEAKER_SOURCE is text');
    return;
  }
  await setState(meeting._id, 'pending');
  await enqueue({ meetingId: meeting._id, stage: 'diarize' });
}

/** Deepgram's word clock for M3, once per meeting; failure only costs accuracy, never the meeting. */
async function ensureWords(ctx: StageContext, meeting: MeetingDoc): Promise<void> {
  if (!env().DEEPGRAM_API_KEY) return;
  const have = await EngineResponseModel.exists({
    meetingId: meeting._id,
    engine: 'deepgram',
    kind: 'words',
    error: null,
  });
  if (have) return;
  try {
    const flac = await ensureAnalysisFlac(ctx.deps, ctx.tmpDir, meeting.audio.originalUrl);
    const language = meeting.languages?.length === 1 ? meeting.languages[0]! : 'hi';
    const r = await deepgramWordClock(flac, 'audio/flac', language === 'gu' ? 'gu' : 'hi');
    await EngineResponseModel.create({
      meetingId: meeting._id,
      kind: 'words',
      chunkIndex: null,
      startSec: 0,
      endSec: r.durationSec,
      engine: 'deepgram',
      model: `nova-3/${r.language}`,
      promptVersion: 'deepgram-words-v1',
      promptHash: '',
      prompt: '',
      userText: '',
      status: 'ok',
      text: null,
      response: r.raw,
      usage: { inputTokens: 0, outputTokens: 0, audioSec: r.durationSec },
      keyLabel: 'DEEPGRAM_API_KEY',
      error: null,
      receivedAt: ctx.deps.now(),
    });
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, 'deepgram word clock unavailable; using M1 only');
  }
}

/** Upload the audio and submit the job; the caller then waits for it. */
async function submit(ctx: StageContext, meeting: MeetingDoc): Promise<void> {
  const flac = await ensureAnalysisFlac(ctx.deps, ctx.tmpDir, meeting.audio.originalUrl);
  const media = await uploadMedia(flac, `p2-${String(meeting._id)}.flac`);
  await P2MediaModel.updateOne(
    { _id: media },
    {
      $set: {
        meetingId: meeting._id,
        kind: 'meeting',
        clip: null,
        durationSec: meeting.durationSec ?? 0,
        bytes: 0,
        uploadedAt: ctx.deps.now(),
      },
    },
    { upsert: true },
  );
  const counts = meeting.expectedParticipants
    ? { minSpeakers: 1, maxSpeakers: meeting.expectedParticipants + 2 }
    : {};
  const jobId = await submitDiarize(media, { model: PIPELINE_MODEL, ...counts });
  await P2PyannoteResponseModel.create({
    meetingId: meeting._id,
    kind: 'diarize',
    model: PIPELINE_MODEL,
    tag: PIPELINE_TAG,
    params: diarizeBody(media, { model: PIPELINE_MODEL, ...counts }),
    jobId,
    status: 'submitted',
    submittedAt: ctx.deps.now(),
    keyLabel: PYANNOTE_KEY_LABEL,
  });
  ctx.log.info({ jobId }, 'pyannote diarization submitted');
}

const waiting = (msg: string): RetryableError =>
  new RetryableError(msg, 'waiting', { retryAfterMs: POLL_MS });

/**
 * Diarize the meeting with pyannote beside transcription. Resumable at every point: a stored
 * result is reused; a job in flight is polled once per run (the stage waits by retrying, never by
 * holding a worker); a job whose result expired (24 h) or was lost is submitted again. If
 * pyannote is unavailable (no key, no credit, rejected) the meeting falls back to Phase 1's text
 * linker and says so.
 */
export const diarizeStage: StageHandler = {
  async run(ctx: StageContext) {
    const { job, deps, log } = ctx;
    const meeting = (await loadMeeting(job.meetingId)) as MeetingDoc;
    const id = meeting._id;
    if (deps.speakerSource !== 'pyannote') {
      await setState(id, 'off', null, 'SPEAKER_SOURCE is text');
      await maybeAdvanceToAssemble(id);
      return;
    }

    try {
      // The pipeline's own run, or the Stage A experiment run of the same model (stored output).
      const prior =
        (await P2PyannoteResponseModel.findOne({
          meetingId: id,
          kind: 'diarize',
          model: PIPELINE_MODEL,
          tag: { $in: [PIPELINE_TAG, 'stageA'] },
          status: 'succeeded',
        })
          .sort({ submittedAt: -1 })
          .lean()) ??
        (await P2PyannoteResponseModel.findOne({
          meetingId: id,
          kind: 'diarize',
          model: PIPELINE_MODEL,
          tag: PIPELINE_TAG,
        })
          .sort({ submittedAt: -1 })
          .lean());
      const fresh = prior && deps.now().getTime() - prior.submittedAt.getTime() < RESULT_TTL_MS;

      if (prior?.status === 'succeeded' && prior.output) {
        // stored: nothing to wait for
      } else if (prior && fresh && !TERMINAL.has(prior.status)) {
        let state;
        try {
          state = await getJob(prior.jobId);
        } catch (err) {
          if (err instanceof PyannoteError && (err.status === 404 || err.status === 410)) {
            await P2PyannoteResponseModel.updateOne(
              { jobId: prior.jobId },
              { $set: { status: 'expired', error: 'result expired before it was fetched' } },
            );
            log.warn({ jobId: prior.jobId }, 'pyannote result expired; submitting again');
            await submit(ctx, meeting);
            throw waiting('Diarization resubmitted; waiting for pyannote');
          }
          throw err;
        }
        if (state.status === 'succeeded') {
          await P2PyannoteResponseModel.updateOne(
            { jobId: prior.jobId },
            {
              $set: { status: 'succeeded', output: state.output ?? null, completedAt: deps.now() },
            },
          );
        } else if (state.status === 'failed' || state.status === 'canceled') {
          await P2PyannoteResponseModel.updateOne(
            { jobId: prior.jobId },
            { $set: { status: state.status, error: `pyannote job ${state.status}` } },
          );
          throw new PyannoteError(`pyannote job ${prior.jobId} ${state.status}`, 0);
        } else {
          throw waiting(`pyannote job ${prior.jobId} is ${state.status}`);
        }
      } else {
        // never submitted, or the result is gone (older than 24 h) or the job failed
        if (prior && !TERMINAL.has(prior.status))
          await P2PyannoteResponseModel.updateOne(
            { jobId: prior.jobId },
            { $set: { status: 'expired', error: 'older than the 24 h result window' } },
          );
        await submit(ctx, meeting);
        throw waiting('Diarization submitted; waiting for pyannote');
      }
    } catch (err) {
      if (err instanceof RetryableError) throw err;
      const status = err instanceof PyannoteError ? err.status : 0;
      if (err instanceof PyannoteError && (status === 429 || status >= 500))
        throw new RetryableError(err.message, status === 429 ? 'rate_limit' : 'server', {
          cause: err,
        });
      // 400/401/402/403 or a failed job: retrying will not help; use the text linker
      const reason = err instanceof Error ? err.message.slice(0, 300) : 'pyannote unavailable';
      log.warn({ reason }, 'pyannote unavailable; falling back to text speaker linking');
      await setState(id, 'fallback', null, reason);
      await maybeAdvanceToAssemble(id);
      return;
    }

    await ensureWords(ctx, meeting);
    const doc = await P2PyannoteResponseModel.findOne({
      meetingId: id,
      kind: 'diarize',
      tag: { $in: [PIPELINE_TAG, 'stageA'] },
      status: 'succeeded',
    }).lean();
    await setState(id, 'done', doc?.jobId ?? null);
    await maybeAdvanceToAssemble(id);
  },

  /** Retries exhausted: the meeting still finishes, with Phase 1's speaker linking. */
  async onGiveUp({ job, log }: StageContext, error: Error) {
    log.error({ err: error.message }, 'diarization given up; using text speaker linking');
    const id = new Types.ObjectId(String(job.meetingId));
    await setState(id, 'fallback', null, error.message.slice(0, 300));
    await maybeAdvanceToAssemble(id);
  },
};
