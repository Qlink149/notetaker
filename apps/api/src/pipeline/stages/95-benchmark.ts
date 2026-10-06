import { join } from 'node:path';
import { Types } from 'mongoose';
import { BenchmarkEngineName } from '@meetingid/shared';
import {
  assembleChunks,
  computeCoverage,
  normalizeChunkTurns,
  turnsToLines,
} from '@meetingid/pipeline';
import { EvalRunModel, MeetingDataModel } from '../../models/index.js';
import type { ChunkAudio } from '../../services/engines/types.js';
import type { StageContext, StageHandler } from '../context.js';
import { FatalError, humanizeError } from '../errors.js';
import { loadMeeting, loadWorkspaceContext } from '../meetings.js';
import { MAX_LINE_SEC, PAUSE_SEC } from './30-assemble.js';

const FLAC = 'audio/flac';

interface BenchmarkPayload {
  evalRunId: string;
  engine: string;
}

function payloadOf(ctx: StageContext): { evalRunId: Types.ObjectId; engine: BenchmarkEngineName } {
  const p = ctx.job.payload as BenchmarkPayload | null;
  const engine = BenchmarkEngineName.safeParse(p?.engine);
  if (!p?.evalRunId || !engine.success)
    throw new FatalError('benchmark job is missing evalRunId/engine');
  return { evalRunId: new Types.ObjectId(p.evalRunId), engine: engine.data };
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
    const { evalRunId, engine: engineName } = payloadOf(ctx);
    const meeting = await loadMeeting(job.meetingId);
    const { workspace, glossary } = await loadWorkspaceContext(meeting.workspaceId);
    const data = await MeetingDataModel.findOne(
      { meetingId: meeting._id },
      { chunks: 1, speechSegments: 1 },
    ).lean();
    const chunks = (data?.chunks ?? []).filter((c) => c.parent === null || c.parent === undefined);
    if (!chunks.length) throw new FatalError('Meeting has not been ingested yet');

    const engine = deps.engine(engineName);
    const languages = meeting.languages.length ? meeting.languages : workspace.settings.languages;
    const started = Date.now();
    const usage = { input: 0, output: 0, audioSec: 0 };
    const perChunk = [];
    let model = '';
    for (const c of chunks) {
      let audio: ChunkAudio;
      if (engine.accepts.includes('url') && c.audioUrl) {
        audio = { kind: 'url', url: c.audioUrl, mimeType: FLAC };
      } else {
        const path = join(tmpDir, `bench-${c.index}.flac`);
        await deps.storage.download(c.audioUrl!, path);
        audio = engine.accepts.includes('gemini-file')
          ? {
              kind: 'gemini-file',
              ...(await deps.geminiFiles.upload(
                path,
                FLAC,
                `bench-${String(meeting._id)}-${c.index}`,
              )),
            }
          : { kind: 'path', path, mimeType: FLAC };
      }
      const r = await engine.transcribeChunk({
        audio,
        startSec: c.startSec,
        endSec: c.endSec,
        languages,
        glossary,
      });
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
