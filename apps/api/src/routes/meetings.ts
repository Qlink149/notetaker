import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import {
  AddPartsBody,
  CreateMeetingBody,
  MAX_MEETING_PARTS,
  UploadSignBody,
  PatchMeetingBody,
  RetryBody,
  SummariseBody,
  type Stage,
} from '@meetingid/shared';
import { ws } from '../lib/auth.js';
import { HttpError, assertEngineEnabled, body, idParam, notFound } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { foldersOf, meetingDataView, meetingView } from '../lib/views.js';
import {
  JobModel,
  MeetingDataModel,
  MeetingModel,
  type MeetingDoc,
  type WorkspaceDoc,
} from '../models/index.js';
import { enqueue } from '../pipeline/queue.js';
import { addContinuation } from '../services/continuation.js';
import { deleteMeetingEverywhere } from '../services/meetingDelete.js';
import { PENDING_CONCAT } from '../pipeline/stages/07-concat.js';
import { meetingFolder } from '../services/storage/cloudinary.js';
import type { ApiDeps } from './deps.js';

/** A folder the workspace has (none when not given); an unknown folder is refused. */
function folderIn(w: WorkspaceDoc, folder: string | null | undefined): string | null {
  if (!folder) return null;
  if (!foldersOf(w).includes(folder)) throw new HttpError(400, 'unknown_folder');
  return folder;
}

export function meetingsRouter(deps: ApiDeps): Router {
  const r = Router();

  const own = async (req: Request): Promise<MeetingDoc> => {
    const m = await MeetingModel.findOne({
      _id: idParam(req),
      workspaceId: ws(req)._id,
    }).lean<MeetingDoc>();
    if (!m) throw notFound('meeting_not_found');
    return m;
  };

  /**
   * Signed browser upload into a meeting's own folder: a fresh meeting id, or (for files 2..n of a meeting
   * uploaded in parts) the id the first file was signed for. Every signature makes its own file name.
   */
  r.post('/uploads/sign', async (req, res) => {
    const { meetingId: given } = body(UploadSignBody, req);
    if (given) {
      const existing = await MeetingModel.findById(given, { workspaceId: 1 }).lean();
      if (existing && String(existing.workspaceId) !== String(ws(req)._id))
        throw notFound('meeting_not_found');
    }
    const meetingId = given ?? new Types.ObjectId().toHexString();
    const folder = meetingFolder(ws(req).slug, meetingId);
    res.json({ meetingId, ...(await deps.storage.signUpload(folder)) });
  });

  r.post('/meetings', async (req, res) => {
    const workspace = ws(req);
    const input = body(CreateMeetingBody, req);
    await assertEngineEnabled([input.engine ?? workspace.settings.engine]);
    const folder = meetingFolder(workspace.slug, input.meetingId);
    const files = input.parts ?? [{ publicId: input.publicId, url: input.url }];
    for (const f of [{ publicId: input.publicId }, ...files])
      if (!f.publicId.startsWith(`${folder}/`))
        throw new HttpError(400, "publicId is not in this meeting's upload folder");
    if (input.parts && input.parts[0]!.publicId !== input.publicId)
      throw new HttpError(400, 'the first part must be the meeting file');
    if (await MeetingModel.exists({ _id: input.meetingId }))
      throw new HttpError(409, 'meeting_exists');
    // several files: joined into one recording first (concat), then the normal pipeline
    const inParts = Boolean(input.parts);
    const meeting = await MeetingModel.create({
      _id: new Types.ObjectId(input.meetingId),
      workspaceId: workspace._id,
      title: input.title,
      date: input.date ? new Date(input.date) : new Date(),
      status: 'processing',
      stage: 'ingest',
      engine: input.engine ?? workspace.settings.engine,
      languages: input.languages ?? workspace.settings.languages,
      expectedParticipants: input.expectedParticipants ?? null,
      folder: folderIn(workspace, input.folder),
      audio: inParts
        ? {
            originalUrl: PENDING_CONCAT,
            originalPublicId: `${folder}/combined`,
            parts: input.parts!.map((f) => ({
              publicId: f.publicId,
              url: f.url,
              fileName: f.fileName ?? null,
              durationSec: null,
              offsetSec: null,
            })),
          }
        : { originalUrl: input.url, originalPublicId: input.publicId },
    });
    await enqueue({ meetingId: meeting._id, stage: inParts ? 'concat' : 'ingest' });
    res.status(201).json({ meeting: meetingView(meeting.toObject() as MeetingDoc) });
  });

  r.get('/meetings', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const list = await MeetingModel.find({ workspaceId: ws(req)._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<MeetingDoc[]>();
    res.json({ meetings: list.map(meetingView) });
  });

  r.get('/meetings/:id', async (req, res) => {
    res.set('Cache-Control', 'no-store').json({ meeting: meetingView(await own(req)) });
  });

  r.get('/meetings/:id/data', async (req, res) => {
    const m = await own(req);
    const data = await MeetingDataModel.findOne(
      { meetingId: m._id },
      { meetingId: 1, turns: 1, lines: 1, speakerMap: 1 },
    ).lean();
    if (!data) throw notFound('meeting_data_not_ready');
    res.set('Cache-Control', 'private, max-age=5').json(meetingDataView(data, m));
  });

  r.patch('/meetings/:id', async (req, res) => {
    const m = await own(req);
    const patch = body(PatchMeetingBody, req);
    const set: Record<string, unknown> = {};
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.folder !== undefined) set.folder = folderIn(ws(req), patch.folder);
    const updated = await MeetingModel.findByIdAndUpdate(
      m._id,
      { $set: set },
      { returnDocument: 'after' },
    ).lean<MeetingDoc>();
    res.json({ meeting: meetingView(updated!) });
  });

  /**
   * Add recordings to the end of a meeting (a continuation recorded later). The files are uploaded into the
   * meeting's folder first (`/uploads/sign` with the meeting id); the meeting is then joined and processed again,
   * keeping the work on the earlier audio that the new audio does not change (`addContinuation`).
   */
  r.post('/meetings/:id/parts', async (req, res) => {
    const m = await own(req);
    const { parts } = body(AddPartsBody, req);
    if (
      m.status === 'processing' ||
      m.audio.originalUrl === PENDING_CONCAT ||
      (await JobModel.exists({
        meetingId: m._id,
        status: { $in: ['queued', 'running'] },
        stage: { $nin: ['benchmark', 'learnvoice'] },
      }))
    )
      throw new HttpError(409, 'meeting_is_processing');
    const folder = meetingFolder(ws(req).slug, String(m._id));
    for (const f of parts)
      if (!f.publicId.startsWith(`${folder}/`))
        throw new HttpError(400, "publicId is not in this meeting's upload folder");
    if ((m.audio.parts?.length || 1) + parts.length > MAX_MEETING_PARTS)
      throw new HttpError(400, `a meeting can hold at most ${MAX_MEETING_PARTS} files`);
    await addContinuation(
      m,
      parts.map((f) => ({
        publicId: f.publicId,
        url: f.url,
        fileName: f.fileName ?? null,
        durationSec: null,
        offsetSec: null,
      })),
    );
    await JobModel.deleteMany({ meetingId: m._id, stage: 'concat', status: 'failed' });
    await enqueue({ meetingId: m._id, stage: 'concat' });
    const updated = await MeetingModel.findById(m._id).lean<MeetingDoc>();
    res.status(202).json({ meeting: meetingView(updated!) });
  });

  /** Re-queue one stage only (fixes X1: never restart from zero). */
  r.post('/meetings/:id/retry', async (req, res) => {
    const m = await own(req);
    const { stage } = body(RetryBody, req);
    if (
      await JobModel.exists({
        meetingId: m._id,
        status: { $in: ['queued', 'running'] },
        stage: { $nin: ['benchmark', 'learnvoice'] },
      })
    ) {
      throw new HttpError(409, 'meeting_is_processing');
    }
    await JobModel.deleteMany({ meetingId: m._id, stage, status: 'failed' });
    if (stage === 'ingest' && m.audio.originalUrl === PENDING_CONCAT) {
      await JobModel.deleteMany({ meetingId: m._id, stage: 'concat', status: 'failed' });
      await MeetingModel.updateOne(
        { _id: m._id },
        { $set: { status: 'processing', stage: 'ingest', error: null } },
      );
      await enqueue({ meetingId: m._id, stage: 'concat' });
    } else if (stage === 'transcribe') {
      const data = await MeetingDataModel.findOne(
        { meetingId: m._id },
        { 'chunks.index': 1, 'chunks.status': 1 },
      ).lean();
      if (!data?.chunks.length) throw new HttpError(409, 'no_chunks_run_ingest');
      await MeetingDataModel.updateOne(
        { meetingId: m._id },
        { $set: { 'chunks.$[c].status': 'pending', 'chunks.$[c].attempts': 0 } },
        { arrayFilters: [{ 'c.status': 'failed' }] },
      );
      const pending = data.chunks.filter((c) => c.status === 'failed' || c.status === 'pending');
      for (const c of pending)
        await enqueue({ meetingId: m._id, stage: 'transcribe', step: c.index });
      const live = data.chunks.filter((c) => c.status !== 'superseded').length;
      await MeetingModel.updateOne(
        { _id: m._id },
        {
          $set: {
            status: 'processing',
            stage: 'transcribe',
            error: null,
            'progress.chunksTotal': live,
            'progress.chunksDone': live - pending.length,
          },
        },
      );
    } else if (stage === 'diarize') {
      // Re-run the voice analysis. The meeting waits at `transcribe`, the point where the pipeline moves
      // on to assemble once transcription AND voice analysis are done (maybeAdvanceToAssemble), so the
      // transcript, identification and summary are rebuilt with the speakers when it finishes.
      await MeetingDataModel.updateOne(
        { meetingId: m._id },
        { $set: { diarize: { state: 'pending', jobId: null, reason: null } } },
      );
      await MeetingModel.updateOne(
        { _id: m._id },
        { $set: { status: 'processing', stage: 'transcribe', error: null } },
      );
      await enqueue({ meetingId: m._id, stage: 'diarize' });
    } else {
      await MeetingModel.updateOne(
        { _id: m._id },
        {
          $set: {
            status: 'processing',
            stage: stage as Stage,
            error: null,
            ...(stage === 'summarise' ? { summaryStatus: 'pending' } : {}),
          },
        },
      );
      await enqueue({ meetingId: m._id, stage });
    }
    const updated = await MeetingModel.findById(m._id).lean<MeetingDoc>();
    res.status(202).json({ meeting: meetingView(updated!) });
  });

  /** "Summarise anyway": bypass the coverage gate. */
  r.post('/meetings/:id/summarise', async (req, res) => {
    const m = await own(req);
    const { force } = body(SummariseBody, req);
    if (!m.coverage) throw new HttpError(409, 'transcript_not_ready');
    await MeetingModel.updateOne(
      { _id: m._id },
      { $set: { status: 'processing', stage: 'summarise', summaryStatus: 'pending', error: null } },
    );
    await enqueue({ meetingId: m._id, stage: 'summarise', payload: { force } });
    const updated = await MeetingModel.findById(m._id).lean<MeetingDoc>();
    res.status(202).json({ meeting: meetingView(updated!) });
  });

  r.delete('/meetings/:id', async (req, res) => {
    const m = await own(req);
    const data = await MeetingDataModel.findOne(
      { meetingId: m._id },
      { 'chunks.geminiFileName': 1, 'chunks.geminiKeyId': 1 },
    ).lean();
    const removed = await deleteMeetingEverywhere(String(m._id), String(ws(req)._id));
    logger.info({ meetingId: String(m._id), ...removed }, 'meeting deleted');
    // Storage cleanup is best effort; the records are already gone.
    void (async () => {
      for (const c of data?.chunks ?? [])
        if (c.geminiFileName)
          await deps.geminiFiles.delete(c.geminiFileName, c.geminiKeyId).catch(() => undefined);
      await deps.storage
        .deleteFolder(meetingFolder(ws(req).slug, String(m._id)))
        .catch((err: unknown) => logger.warn({ err }, 'storage cleanup failed'));
    })();
    res.status(204).end();
  });

  return r;
}
