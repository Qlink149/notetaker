import { findTranscriptGaps, normalizeChunkTurns } from '@meetingid/pipeline';
import { env } from '../../config/env.js';
import { MeetingDataModel, MeetingModel, type GapFillDoc } from '../../models/index.js';
import {
  assertBudget,
  BudgetExceededError,
  estimateGeminiChunkUsd,
  recordSpend,
  usdFor,
} from '../budget.js';
import { materializeChunk } from '../chunkAudio.js';
import type { StageContext, StageHandler } from '../context.js';
import { FatalError, RetryableError } from '../errors.js';
import { addCost, loadMeeting, loadWorkspaceContext } from '../meetings.js';
import { enqueue } from '../queue.js';
import { saveEngineResponse } from '../responses.js';
import { loadJoinInput } from '../../services/identity/joinInput.js';
import { rebuildTranscript } from '../transcript.js';
import { rawOf } from '../../services/engines/types.js';

/** Engine calls allowed per meeting for gap filling, failed ones included. */
export const MAX_GAP_CALLS = 6;
/** Audio kept either side of a gap so the engine has context and speakers can be linked. */
export const GAP_PAD_SEC = 5;
/** Only gaps with at least this much uncovered speech are worth a call. */
export const MIN_GAP_SEC = 5;

const FLAC = 'audio/flac';
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start < b.end && b.start < a.end;

/**
 * Re-transcribe stretches of detected speech the chunk calls skipped: each gap is cut with 5 s of
 * padding, sent with the same prompt, and its turns are merged in. Longest gaps first, at most
 * six calls per meeting. Every call is saved as soon as it returns, so a retry never pays twice.
 */
export const gapfillStage: StageHandler = {
  async run({ job, deps, log, tmpDir }: StageContext) {
    const meeting = await loadMeeting(job.meetingId);
    const data = await MeetingDataModel.findOne({ meetingId: meeting._id }).lean();
    if (!data) throw new FatalError('Meeting data missing; re-run ingest');
    const tried = data.gapFills ?? [];
    const gaps = findTranscriptGaps(data.speechSegments, data.turns as never, {
      minSec: MIN_GAP_SEC,
    })
      .filter((g) => !tried.some((t) => overlaps(t, g)))
      .slice(0, Math.max(0, MAX_GAP_CALLS - tried.length));

    if (gaps.length && data.turns.length) {
      const { workspace, glossary } = await loadWorkspaceContext(meeting.workspaceId);
      const engine = deps.engine(meeting.engine);
      const provider = engine.name === 'deepgram' ? 'deepgram' : 'gemini';
      const duration = meeting.durationSec ?? Number.POSITIVE_INFINITY;
      for (const [i, gap] of gaps.entries()) {
        const cutStart = Math.max(0, gap.start - GAP_PAD_SEC);
        const cutEnd = Math.min(duration, gap.end + GAP_PAD_SEC);
        const record: GapFillDoc = {
          start: gap.start,
          end: gap.end,
          cutStart,
          cutEnd,
          status: 'failed',
          model: null,
          error: null,
          turns: [],
          responseId: null,
        };
        const where = {
          meetingId: meeting._id,
          kind: 'gapfill' as const,
          startSec: cutStart,
          endSec: cutEnd,
        };
        try {
          await assertBudget(
            provider,
            estimateGeminiChunkUsd(env().GEMINI_MODEL, cutEnd - cutStart),
          );
          const path = await materializeChunk(
            deps,
            tmpDir,
            meeting.audio.originalUrl,
            cutStart,
            cutEnd,
            `gap-${i}`,
          );
          const result = await engine.transcribeChunk({
            audio: { kind: 'path', path, mimeType: FLAC },
            localPath: async () => path,
            startSec: cutStart,
            endSec: cutEnd,
            languages: meeting.languages.length ? meeting.languages : workspace.settings.languages,
            glossary,
          });
          record.responseId = await saveEngineResponse(
            result.raw,
            where,
            result.finish === 'truncated' ? 'truncated' : null,
          );
          const usd = usdFor(provider, result.model, result.usage);
          await addCost(meeting._id, {
            usd,
            geminiInputTokens: result.usage.inputTokens,
            geminiOutputTokens: result.usage.outputTokens,
            deepgramSec: result.usage.audioSec,
          });
          await recordSpend(provider, usd);
          if (result.uploaded) {
            await deps.geminiFiles
              .delete(result.uploaded.name, result.uploaded.keyId)
              .catch(() => undefined);
          }
          record.model = result.model;
          if (result.finish === 'truncated') record.error = 'truncated';
          else {
            record.status = 'done';
            record.turns = normalizeChunkTurns(result.turns, cutEnd - cutStart, cutStart);
          }
        } catch (err) {
          // Out of quota: stop here and wait; the gaps saved so far are kept.
          if (err instanceof RetryableError && (err.reason === 'quota' || err.reason === 'waiting'))
            throw err;
          if (err instanceof BudgetExceededError) throw err;
          record.error = err instanceof Error ? err.message.slice(0, 300) : String(err);
          record.responseId = await saveEngineResponse(rawOf(err), where, record.error);
        }
        await MeetingDataModel.updateOne(
          { meetingId: meeting._id },
          { $push: { gapFills: record } },
        );
        log.info(
          { gap, status: record.status, turns: record.turns.length, error: record.error },
          'gap filled',
        );
      }
    }

    const fresh = await MeetingDataModel.findOne({ meetingId: meeting._id }).lean();
    const before = meeting.coverage?.ratio ?? null;
    const join =
      deps.speakerSource === 'pyannote' ? await loadJoinInput(String(meeting._id)) : null;
    const built =
      gaps.length && fresh ? await rebuildTranscript(meeting, fresh, deps.resolver, join) : null;
    await MeetingModel.updateOne({ _id: meeting._id }, { $set: { stage: 'summarise' } });
    // pyannote meetings name their voices before the summary is written
    await enqueue({
      meetingId: meeting._id,
      stage: deps.speakerSource === 'pyannote' ? 'identify' : 'summarise',
    });
    log.info(
      {
        calls: gaps.length,
        coverageBefore: before,
        coverageAfter: built?.coverage.ratio ?? before,
      },
      'gap fill finished',
    );
  },
};
