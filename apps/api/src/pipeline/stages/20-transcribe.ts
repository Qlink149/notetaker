import { join } from 'node:path';
import type { Types } from 'mongoose';
import { looksRepetitive, normalizeChunkTurns, splitChunk } from '@meetingid/pipeline';
import { MeetingDataModel, MeetingModel } from '../../models/index.js';
import type { ChunkAudio } from '../../services/engines/types.js';
import { meetingFolder } from '../../services/storage/cloudinary.js';
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

    let localPath: string | null = null;
    const ensureLocal = async (): Promise<string> => {
      if (localPath) return localPath;
      if (!chunk.audioUrl)
        throw new FatalError(`Chunk ${index} has no stored audio; re-run ingest`);
      localPath = join(tmpDir, `chunk-${index}.flac`);
      await deps.storage.download(chunk.audioUrl, localPath);
      return localPath;
    };

    let audio: ChunkAudio;
    const fresh =
      chunk.geminiFileUri &&
      chunk.uploadedAt &&
      deps.now().getTime() - new Date(chunk.uploadedAt).getTime() < GEMINI_FILE_TTL_MS;
    if (engine.accepts.includes('gemini-file') && fresh) {
      audio = { kind: 'gemini-file', uri: chunk.geminiFileUri!, mimeType: FLAC };
    } else if (engine.accepts.includes('gemini-file')) {
      const up = await deps.geminiFiles.upload(
        await ensureLocal(),
        FLAC,
        `${String(meeting._id)}-${index}`,
      );
      await MeetingDataModel.updateOne(
        { meetingId: meeting._id, 'chunks.index': index },
        {
          $set: {
            'chunks.$.geminiFileUri': up.uri,
            'chunks.$.geminiFileName': up.name,
            'chunks.$.uploadedAt': deps.now(),
          },
        },
      );
      audio = { kind: 'gemini-file', uri: up.uri, mimeType: FLAC };
    } else if (engine.accepts.includes('url') && chunk.audioUrl) {
      audio = { kind: 'url', url: chunk.audioUrl, mimeType: FLAC };
    } else {
      audio = { kind: 'path', path: await ensureLocal(), mimeType: FLAC };
    }

    const started = Date.now();
    const result = await engine.transcribeChunk({
      audio,
      startSec: chunk.startSec,
      endSec: chunk.endSec,
      languages: meeting.languages.length ? meeting.languages : workspace.settings.languages,
      glossary,
    });
    // Paid for whatever the outcome.
    await addCost(meeting._id, {
      geminiInputTokens: result.usage.inputTokens,
      geminiOutputTokens: result.usage.outputTokens,
      deepgramSec: result.usage.audioSec,
    });

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
        await splitAndRequeue({
          meetingId: meeting._id,
          chunk,
          ensureLocal,
          ctxDeps: deps,
          tmpDir,
          slug: workspace.slug,
        });
        return;
      }
      throw new RetryableError(`Chunk ${index} output ${bad}`, 'truncated');
    }

    const duration = chunk.endSec - chunk.startSec;
    const turns = normalizeChunkTurns(result.turns, duration, chunk.startSec);
    const saved = await MeetingDataModel.updateOne(
      { meetingId: meeting._id, chunks: { $elemMatch: { index, status: 'pending' } } },
      { $set: { 'chunks.$.status': 'done', 'chunks.$.rawTurns': turns } },
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

async function splitAndRequeue(args: {
  meetingId: Types.ObjectId;
  chunk: { index: number; startSec: number; endSec: number };
  ensureLocal: () => Promise<string>;
  ctxDeps: StageContext['deps'];
  tmpDir: string;
  slug: string;
}): Promise<void> {
  const { meetingId, chunk, ensureLocal, ctxDeps: deps, tmpDir, slug } = args;
  const all = await loadChunkStatuses(meetingId);
  const nextIndex = Math.max(...all.map((c) => c.index)) + 1;
  const halves = splitChunk(chunk, OVERLAP_SEC, nextIndex);
  const source = await ensureLocal();
  const folder = meetingFolder(slug, String(meetingId));

  const records = [];
  for (const h of halves) {
    const path = join(tmpDir, `chunk-${h.index}.flac`);
    await deps.audio.cutFlac(source, path, h.startSec - chunk.startSec, h.endSec - chunk.startSec);
    const up = await deps.storage.uploadRaw(path, `${folder}/chunks/chunk-${h.index}.flac`);
    records.push({
      ...h,
      audioUrl: up.url,
      audioPublicId: up.publicId,
      geminiFileUri: null,
      geminiFileName: null,
      uploadedAt: null,
      status: 'pending' as const,
      attempts: 0,
      parent: chunk.index,
      rawTurns: [],
    });
  }
  const res = await MeetingDataModel.updateOne(
    { meetingId, chunks: { $elemMatch: { index: chunk.index, status: 'pending' } } },
    { $set: { 'chunks.$.status': 'superseded' } },
  );
  if (res.modifiedCount !== 1) return; // another worker already handled this chunk
  await MeetingDataModel.updateOne({ meetingId }, { $push: { chunks: { $each: records } } });
  await MeetingModel.updateOne({ _id: meetingId }, { $inc: { 'progress.chunksTotal': 1 } });
  for (const r of records) await enqueue({ meetingId, stage: 'transcribe', step: r.index });
}
