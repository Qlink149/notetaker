import { Router } from 'express';
import { Types } from 'mongoose';
import { BenchmarkRunBody, PromoteEvalSetBody } from '@meetingid/shared';
import { ws } from '../lib/auth.js';
import { HttpError, body, idParam, notFound } from '../lib/http.js';
import { evalRunView } from '../lib/views.js';
import {
  EvalRunModel,
  EvalSetModel,
  MeetingDataModel,
  MeetingModel,
  type EvalRunDoc,
} from '../models/index.js';
import { enqueue } from '../pipeline/queue.js';

/** Fixed and extended benchmark (X6): any ingested meetings × any engines, results saved. */
export function benchmarkRouter(): Router {
  const r = Router();

  r.post('/benchmark/run', async (req, res) => {
    const workspace = ws(req);
    const input = body(BenchmarkRunBody, req);
    const meetingIds = input.meetingIds.map((id) => {
      if (!Types.ObjectId.isValid(id)) throw new HttpError(400, `invalid meeting id ${id}`);
      return new Types.ObjectId(id);
    });
    const owned = await MeetingModel.countDocuments({
      _id: { $in: meetingIds },
      workspaceId: workspace._id,
    });
    if (owned !== meetingIds.length) throw notFound('meeting_not_found');
    const ingested = await MeetingDataModel.countDocuments({
      meetingId: { $in: meetingIds },
      'chunks.0': { $exists: true },
    });
    if (ingested !== meetingIds.length)
      throw new HttpError(409, 'every meeting must be ingested before benchmarking');

    let evalSetId: Types.ObjectId | null = null;
    if (input.evalSetName) {
      const set = await EvalSetModel.create({
        workspaceId: workspace._id,
        name: input.evalSetName,
        items: meetingIds.map((meetingId) => ({ meetingId })),
      });
      evalSetId = set._id;
    }
    const run = await EvalRunModel.create({
      workspaceId: workspace._id,
      evalSetId,
      engines: input.engines,
      meetingIds,
      results: meetingIds.flatMap((meetingId) =>
        input.engines.map((engine) => ({ meetingId, engine })),
      ),
    });
    for (const meetingId of meetingIds) {
      for (const engine of input.engines) {
        // step disambiguates jobs per (run, engine) for the same meeting
        await enqueue({
          meetingId,
          stage: 'benchmark',
          step: (Date.now() % 1e9) + input.engines.indexOf(engine),
          payload: { evalRunId: String(run._id), engine },
          maxAttempts: 3,
        });
      }
    }
    res.status(202).json({ run: evalRunView(run.toObject() as EvalRunDoc) });
  });

  r.get('/benchmark/runs', async (req, res) => {
    const runs = await EvalRunModel.find(
      { workspaceId: ws(req)._id },
      { 'results.transcriptLines': 0 },
    )
      .sort({ createdAt: -1 })
      .limit(20)
      .lean<EvalRunDoc[]>();
    res.json({ runs: runs.map(evalRunView) });
  });

  r.get('/benchmark/runs/:id', async (req, res) => {
    const run = await EvalRunModel.findOne({
      _id: idParam(req),
      workspaceId: ws(req)._id,
    }).lean<EvalRunDoc>();
    if (!run) throw notFound('run_not_found');
    res.json({ run: evalRunView(run) });
  });

  r.post('/benchmark/eval-sets', async (req, res) => {
    const workspace = ws(req);
    const input = body(PromoteEvalSetBody, req);
    const set = await EvalSetModel.create({
      workspaceId: workspace._id,
      name: input.name,
      items: input.meetingIds
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => ({ meetingId: new Types.ObjectId(id) })),
    });
    res
      .status(201)
      .json({ evalSet: { id: String(set._id), name: set.name, size: set.items.length } });
  });

  return r;
}
