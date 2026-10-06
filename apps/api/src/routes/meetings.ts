import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import {
  CreateMeetingBody,
  PatchMeetingBody,
  RetryBody,
  SummariseBody,
  type Stage,
} from '@meetingid/shared';
import { ws } from '../lib/auth.js';
import { HttpError, body, idParam, notFound } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { meetingDataView, meetingView } from '../lib/views.js';
import { JobModel, MeetingDataModel, MeetingModel, type MeetingDoc } from '../models/index.js';
import { enqueue } from '../pipeline/queue.js';
import { meetingFolder } from '../services/storage/cloudinary.js';
import type { ApiDeps } from './deps.js';

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

  /** Signed browser upload bound to a fresh meeting id and its own folder. */
  r.post('/uploads/sign', (req, res) => {
    const meetingId = new Types.ObjectId().toHexString();
    const folder = meetingFolder(ws(req).slug, meetingId);
    res.json({ meetingId, ...deps.storage.signUpload(folder) });
  });

  r.post('/meetings', async (req, res) => {
    const workspace = ws(req);
    const input = body(CreateMeetingBody, req);
    const folder = meetingFolder(workspace.slug, input.meetingId);
    if (!input.publicId.startsWith(`${folder}/`))
      throw new HttpError(400, "publicId is not in this meeting's upload folder");
    if (await MeetingModel.exists({ _id: input.meetingId }))
      throw new HttpError(409, 'meeting_exists');
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
      audio: { originalUrl: input.url, originalPublicId: input.publicId },
    });
    await enqueue({ meetingId: meeting._id, stage: 'ingest' });
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
    const { title } = body(PatchMeetingBody, req);
    const updated = await MeetingModel.findByIdAndUpdate(
      m._id,
      { $set: { title } },
      { returnDocument: 'after' },
    ).lean<MeetingDoc>();
    res.json({ meeting: meetingView(updated!) });
  });

  /** Re-queue one stage only (fixes X1: never restart from zero). */
  r.post('/meetings/:id/retry', async (req, res) => {
    const m = await own(req);
    const { stage } = body(RetryBody, req);
    if (
      await JobModel.exists({
        meetingId: m._id,
        status: { $in: ['queued', 'running'] },
        stage: { $ne: 'benchmark' },
      })
    ) {
      throw new HttpError(409, 'meeting_is_processing');
    }
    await JobModel.deleteMany({ meetingId: m._id, stage, status: 'failed' });
    if (stage === 'transcribe') {
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
      { 'chunks.geminiFileName': 1 },
    ).lean();
    await Promise.all([
      MeetingModel.deleteOne({ _id: m._id }),
      MeetingDataModel.deleteOne({ meetingId: m._id }),
      JobModel.deleteMany({ meetingId: m._id }),
    ]);
    // Storage cleanup is best effort; the records are already gone.
    void (async () => {
      for (const c of data?.chunks ?? [])
        if (c.geminiFileName)
          await deps.geminiFiles.delete(c.geminiFileName).catch(() => undefined);
      await deps.storage
        .deleteFolder(meetingFolder(ws(req).slug, String(m._id)))
        .catch((err: unknown) => logger.warn({ err }, 'storage cleanup failed'));
    })();
    res.status(204).end();
  });

  return r;
}
