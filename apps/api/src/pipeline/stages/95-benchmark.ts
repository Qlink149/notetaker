import { Types } from 'mongoose';
import { BenchmarkEngineName, Language } from '@meetingid/shared';
import {
  assembleChunks,
  computeCoverage,
  normalizeChunkTurns,
  turnsToLines,
} from '@meetingid/pipeline';
import { env } from '../../config/env.js';
import { EvalRunModel, MeetingDataModel, MeetingModel } from '../../models/index.js';
import { assertBudget, estimateGeminiChunkUsd, recordSpend, usdFor } from '../budget.js';
import { materializeChunk } from '../chunkAudio.js';
import type { StageContext, StageHandler } from '../context.js';
import { FatalError, humanizeError } from '../errors.js';
import { loadMeeting, loadWorkspaceContext } from '../meetings.js';
import { saveEngineResponse } from '../responses.js';
import { rawOf } from '../../services/engines/types.js';
import { MAX_LINE_SEC, PAUSE_SEC } from './30-assemble.js';

const FLAC = 'audio/flac';

interface BenchmarkPayload {
  evalRunId: string;
  engine: string;
  /** Override the meeting's languages for this run (e.g. Deepgram with an explicit language). */
  languages?: string[];
}

function payloadOf(ctx: StageContext): {
  evalRunId: Types.ObjectId;
  engine: BenchmarkEngineName;
  languages: Language[] | null;
} {
  const p = ctx.job.payload as BenchmarkPayload | null;
  const engine = BenchmarkEngineName.safeParse(p?.engine);
  if (!p?.evalRunId || !engine.success)
    throw new FatalError('benchmark job is missing evalRunId/engine');
  const languages = p.languages?.length ? Language.array().parse(p.languages) : null;
  return { evalRunId: new Types.ObjectId(p.evalRunId), engine: engine.data, languages };
}

async function saveResult(
  evalRunId: Types.ObjectId,
  meetingId: Types.ObjectId,
  engine: string,
  result: Record<string, unknown>,
): Promise<void> {
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) set[`results.$[r].${k}`] = v;
  await EvalRunModel.updateOne(
    { _id: evalRunId },
    { $set: set },
    { arrayFilters: [{ 'r.meetingId': meetingId, 'r.engine': engine }] },
  );
  const run = await EvalRunModel.findById(evalRunId, { 'results.status': 1 }).lean();
  if (run && run.results.every((r) => r.status !== 'pending')) {
    await EvalRunModel.updateOne({ _id: evalRunId }, { $set: { status: 'done' } });
  }
}

/** Run one engine over every original chunk of an already-ingested meeting. Writes nothing to the meeting. */
export const benchmarkStage: StageHandler = {
  async run(ctx: StageContext) {
    const { job, deps, log, tmpDir } = ctx;
    const { evalRunId, engine: engineName, languages: override } = payloadOf(ctx);
    const meeting = await loadMeeting(job.meetingId);
    const { workspace, glossary } = await loadWorkspaceContext(meeting.workspaceId);
    const data = await MeetingDataModel.findOne({ meetingId: meeting._id }).lean();
    const chunks = (data?.chunks ?? []).filter((c) => c.parent === null || c.parent === undefined);
    if (!chunks.length) throw new FatalError('Meeting has not been ingested yet');

    const engine = deps.engine(engineName);
    const languages =
      override ?? (meeting.languages.length ? meeting.languages : workspace.settings.languages);
    const started = Date.now();
    const usage = { input: 0, output: 0, audioSec: 0 };
    const perChunk = [];
    let model = '';
    // The pipeline already transcribed this meeting with Gemini: reuse that instead of spending quota.
    const pipelineDone = (data?.chunks ?? []).filter((c) => c.status === 'done');
    const reuse =
      engineName === 'gemini' &&
      !override &&
      pipelineDone.length > 0 &&
      (data?.chunks ?? []).every((c) => c.status === 'done' || c.status === 'superseded') &&
      pipelineDone.every((c) => (c.model ?? '').startsWith('gemini'));
    if (reuse) {
      model = `${[...new Set(pipelineDone.map((c) => c.model))].join('+')} (pipeline run)`;
      for (const c of pipelineDone)
        perChunk.push({ startSec: c.startSec, endSec: c.endSec, turns: c.rawTurns });
      const m = await MeetingModel.findById(meeting._id, { cost: 1 }).lean();
      usage.input = m?.cost.geminiInputTokens ?? 0;
      usage.output = m?.cost.geminiOutputTokens ?? 0;
    }
    const provider = engineName === 'deepgram' ? 'deepgram' : 'gemini';
    for (const c of reuse ? [] : chunks) {
      const path = await materializeChunk(
        deps,
        tmpDir,
        meeting.audio.originalUrl,
        c.startSec,
        c.endSec,
        `bench-${c.index}`,
      );
      await assertBudget(
        provider,
        estimateGeminiChunkUsd(env().GEMINI_MODEL, c.endSec - c.startSec),
      );
      const where = {
        meetingId: meeting._id,
        kind: 'benchmark' as const,
        chunkIndex: c.index,
        startSec: c.startSec,
        endSec: c.endSec,
      };
      let r;
      try {
        r = await engine.transcribeChunk({
          audio: { kind: 'path', path, mimeType: FLAC },
          localPath: async () => path,
          startSec: c.startSec,
          endSec: c.endSec,
          languages,
          glossary,
        });
      } catch (err) {
        await saveEngineResponse(rawOf(err), where, (err as Error).message.slice(0, 500));
        throw err;
      }
      await saveEngineResponse(r.raw, where, r.finish === 'truncated' ? 'truncated' : null);
      await recordSpend(provider, usdFor(provider, r.model, r.usage));
      if (r.uploaded)
        await deps.geminiFiles.delete(r.uploaded.name, r.uploaded.keyId).catch(() => undefined);
      model = r.model;
      usage.input += r.usage.inputTokens;
      usage.output += r.usage.outputTokens;
      usage.audioSec += r.usage.audioSec;
      perChunk.push({
        startSec: c.startSec,
        endSec: c.endSec,
        turns: normalizeChunkTurns(r.turns, c.endSec - c.startSec, c.startSec),
      });
    }

    const { turns } = assembleChunks(perChunk);
    const { speakerMap } = await deps.resolver.resolve({ turns, analysisUrl: null });
    const lines = turnsToLines(turns, speakerMap, {
      maxLineSec: MAX_LINE_SEC,
      pauseSec: PAUSE_SEC,
    });
    const coverage = computeCoverage(data?.speechSegments ?? [], turns);
    await saveResult(evalRunId, meeting._id, engineName, {
      status: 'done',
      error: null,
      model,
      coverage: coverage.ratio,
      turns: turns.length,
      words: turns.reduce((n, t) => n + t.textRoman.split(/\s+/).filter(Boolean).length, 0),
      durationMs: Date.now() - started,
      costTokens: usage,
      transcriptLines: lines,
    });
    log.info(
      { engine: engineName, coverage: coverage.ratio, turns: turns.length },
      'benchmark result saved',
    );
  },

  async onGiveUp(ctx: StageContext, error: Error) {
    const { evalRunId, engine } = payloadOf(ctx);
    await saveResult(evalRunId, ctx.job.meetingId, engine, {
      status: 'failed',
      error: humanizeError(error),
    });
  },
};
