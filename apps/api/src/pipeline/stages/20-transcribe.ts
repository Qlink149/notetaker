import type { Types } from 'mongoose';
import { looksRepetitive, normalizeChunkTurns, splitChunk } from '@meetingid/pipeline';
import { MeetingDataModel, MeetingModel } from '../../models/index.js';
import type { ChunkAudio } from '../../services/engines/types.js';
import { env } from '../../config/env.js';
import { assertBudget, estimateGeminiChunkUsd, recordSpend, usdFor } from '../budget.js';
import { materializeChunk } from '../chunkAudio.js';
import type { StageContext, StageHandler } from '../context.js';
import { FatalError, RetryableError } from '../errors.js';
import { addCost, loadChunkStatuses, loadMeeting, loadWorkspaceContext } from '../meetings.js';
import { enqueue } from '../queue.js';
import { OVERLAP_SEC } from './10-ingest.js';

const FLAC = 'audio/flac';
/** Gemini Files expire after 48 h; re-upload a little before that. */
const GEMINI_FILE_TTL_MS = 46 * 3600_000;
/** Bad (truncated / looping) outputs tolerated per chunk before it is split in half. */
const BAD_OUTPUTS_BEFORE_SPLIT = 2;
/** Chunks shorter than this are not split again; they fail instead. */
const MIN_SPLIT_SEC = 240;

async function loadChunk(meetingId: Types.ObjectId, index: number) {
  const data = await MeetingDataModel.findOne(
    { meetingId },
    { chunks: { $elemMatch: { index } }, meetingId: 1 },
  ).lean();
  return data?.chunks?.[0] ?? null;
}

/**
 * Once every live chunk is done or failed, move the meeting to `assemble` exactly once: the
 * conditional update on `stage: 'transcribe'` lets only one finishing job win.
 */
export async function maybeAdvanceToAssemble(meetingId: Types.ObjectId): Promise<boolean> {
  const live = (await loadChunkStatuses(meetingId)).filter((c) => c.status !== 'superseded');
  if (!live.length || live.some((c) => c.status === 'pending')) return false;
  const won = await MeetingModel.findOneAndUpdate(
    { _id: meetingId, stage: 'transcribe' },
    { $set: { stage: 'assemble' } },
  ).lean();
  if (won) await enqueue({ meetingId, stage: 'assemble' });
  return Boolean(won);
}

export const transcribeStage: StageHandler = {
  async run({ job, deps, log, tmpDir }: StageContext) {
    const index = job.step;
    if (index === null || index === undefined)
      throw new FatalError('transcribe job without a chunk index');
    const meeting = await loadMeeting(job.meetingId);
    const chunk = await loadChunk(meeting._id, index);
    if (!chunk) throw new FatalError(`Chunk ${index} not found; re-run ingest`);
    if (chunk.status !== 'pending') {
      // Already transcribed (a duplicate or reclaimed job): never pay for it twice (F1).
      await maybeAdvanceToAssemble(meeting._id);
      return;
    }
    const { workspace, glossary } = await loadWorkspaceContext(meeting.workspaceId);
    const engine = deps.engine(meeting.engine);

    // Chunk audio is re-cut from the original only when it is needed as a file.
    const ensureLocal = (): Promise<string> =>
      materializeChunk(
        deps,
        tmpDir,
        meeting.audio.originalUrl,
        chunk.startSec,
        chunk.endSec,
        `chunk-${index}`,
      );

    let audio: ChunkAudio;
    const fresh =
      chunk.geminiFileUri &&
      chunk.uploadedAt &&
      deps.now().getTime() - new Date(chunk.uploadedAt).getTime() < GEMINI_FILE_TTL_MS;
    if (engine.accepts.includes('gemini-file') && fresh) {
      audio = {
        kind: 'gemini-file',
        uri: chunk.geminiFileUri!,
        mimeType: FLAC,
        keyId: chunk.geminiKeyId,
      };
    } else {
      // The engine uploads it (Gemini) or reads it (Deepgram).
      audio = { kind: 'path', path: await ensureLocal(), mimeType: FLAC };
    }

    const provider = engine.name === 'deepgram' ? 'deepgram' : 'gemini';
    await assertBudget(
      provider,
      estimateGeminiChunkUsd(env().GEMINI_MODEL, chunk.endSec - chunk.startSec),
    );

    const started = Date.now();
    const result = await engine.transcribeChunk({
      audio,
      localPath: ensureLocal,
      startSec: chunk.startSec,
      endSec: chunk.endSec,
      languages: meeting.languages.length ? meeting.languages : workspace.settings.languages,
      glossary,
    });
    if (result.uploaded) {
      await MeetingDataModel.updateOne(
        { meetingId: meeting._id, 'chunks.index': index },
        {
          $set: {
            'chunks.$.geminiFileUri': result.uploaded.uri,
            'chunks.$.geminiFileName': result.uploaded.name,
            'chunks.$.geminiKeyId': result.uploaded.keyId,
            'chunks.$.uploadedAt': deps.now(),
          },
        },
      );
    }
    // Paid for whatever the outcome.
    const usd = usdFor(provider, result.model, result.usage);
    await addCost(meeting._id, {
      usd,
      geminiInputTokens: result.usage.inputTokens,
      geminiOutputTokens: result.usage.outputTokens,
      deepgramSec: result.usage.audioSec,
    });
    await recordSpend(provider, usd);

    const text = result.turns.map((t) => t.text_roman || t.text_native).join('\n');
    const bad =
      result.finish === 'truncated' ? 'truncated' : looksRepetitive(text) ? 'repetitive' : null;
    if (bad) {
      const updated = await MeetingDataModel.findOneAndUpdate(
        { meetingId: meeting._id, 'chunks.index': index, 'chunks.status': 'pending' },
        { $inc: { 'chunks.$.attempts': 1 } },
        { returnDocument: 'after', projection: { chunks: { $elemMatch: { index } } } },
      ).lean();
      const attempts = updated?.chunks?.[0]?.attempts ?? 1;
      log.warn({ bad, attempts }, 'engine output rejected');
      const length = chunk.endSec - chunk.startSec;
      if (attempts >= BAD_OUTPUTS_BEFORE_SPLIT && length >= MIN_SPLIT_SEC) {
        await splitAndRequeue(meeting._id, chunk);
        return;
      }
      throw new RetryableError(`Chunk ${index} output ${bad}`, 'truncated');
    }

    const duration = chunk.endSec - chunk.startSec;
    const turns = normalizeChunkTurns(result.turns, duration, chunk.startSec);
    const saved = await MeetingDataModel.updateOne(
      { meetingId: meeting._id, chunks: { $elemMatch: { index, status: 'pending' } } },
      {
        $set: {
          'chunks.$.status': 'done',
          'chunks.$.rawTurns': turns,
          'chunks.$.model': result.model,
        },
      },
    );
    if (saved.modifiedCount === 1) {
      await MeetingModel.updateOne({ _id: meeting._id }, { $inc: { 'progress.chunksDone': 1 } });
    }
    log.info(
      { turns: turns.length, model: result.model, ms: Date.now() - started, usage: result.usage },
      'chunk transcribed',
    );
    await maybeAdvanceToAssemble(meeting._id);
  },

  /** A chunk that keeps failing is given up on; the meeting still assembles and ends `partial`. */
  async onGiveUp({ job, log }: StageContext, error: Error) {
    if (job.step === null || job.step === undefined) return;
    await MeetingDataModel.updateOne(
      { meetingId: job.meetingId, chunks: { $elemMatch: { index: job.step, status: 'pending' } } },
      { $set: { 'chunks.$.status': 'failed' } },
    );
    log.error({ err: error.message }, 'chunk permanently failed');
    await maybeAdvanceToAssemble(job.meetingId);
  },
};

/** Replace a chunk that keeps failing with two halves (audio is re-cut on demand when they run). */
async function splitAndRequeue(
  meetingId: Types.ObjectId,
  chunk: { index: number; startSec: number; endSec: number },
): Promise<void> {
  const all = await loadChunkStatuses(meetingId);
  const nextIndex = Math.max(...all.map((c) => c.index)) + 1;
  const records = splitChunk(chunk, OVERLAP_SEC, nextIndex).map((h) => ({
    ...h,
    audioUrl: null,
    audioPublicId: null,
    geminiFileUri: null,
    geminiFileName: null,
    geminiKeyId: null,
    uploadedAt: null,
    model: null,
    status: 'pending' as const,
    attempts: 0,
    parent: chunk.index,
    rawTurns: [],
  }));
  const res = await MeetingDataModel.updateOne(
    { meetingId, chunks: { $elemMatch: { index: chunk.index, status: 'pending' } } },
    { $set: { 'chunks.$.status': 'superseded' } },
  );
  if (res.modifiedCount !== 1) return; // another worker already handled this chunk
  await MeetingDataModel.updateOne({ meetingId }, { $push: { chunks: { $each: records } } });
  await MeetingModel.updateOne({ _id: meetingId }, { $inc: { 'progress.chunksTotal': 1 } });
  for (const r of records) await enqueue({ meetingId, stage: 'transcribe', step: r.index });
}
