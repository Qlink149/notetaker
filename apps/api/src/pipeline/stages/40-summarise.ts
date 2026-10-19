import type { Line } from '@meetingid/shared';
import { MeetingDataModel, MeetingModel } from '../../models/index.js';
import type { StageContext, StageHandler } from '../context.js';
import { assertBudget, estimateClaudeUsd, recordSpend, usdFor } from '../budget.js';
import { humanizeError } from '../errors.js';
import { addCost, loadMeeting, loadWorkspaceContext } from '../meetings.js';
import { enqueue } from '../queue.js';

/** Below this share of detected speech, no summary is written unless the user forces one (D1). */
export const MIN_COVERAGE = 0.6;

export const summariseStage: StageHandler = {
  async run({ job, deps, log }: StageContext) {
    const meeting = await loadMeeting(job.meetingId);
    const force = Boolean((job.payload as { force?: boolean } | null)?.force);
    const ratio = meeting.coverage?.ratio ?? 0;

    const data = await MeetingDataModel.findOne(
      { meetingId: meeting._id },
      { lines: 1, speakerMap: 1 },
    ).lean();
    const lines = (data?.lines ?? []) as Line[];

    if (!lines.length || (ratio < MIN_COVERAGE && !force)) {
      await MeetingModel.updateOne(
        { _id: meeting._id },
        {
          $set: {
            summaryStatus: 'skipped_low_coverage',
            summary: null,
            actionItems: [],
            stage: 'finalise',
          },
        },
      );
      log.info({ ratio, lines: lines.length }, 'summary withheld: low coverage');
      await enqueue({ meetingId: meeting._id, stage: 'finalise' });
      return;
    }

    const { workspace, glossary } = await loadWorkspaceContext(meeting.workspaceId);
    const chars = lines.reduce((n, l) => n + l.textRoman.length + 20, 0);
    await assertBudget('claude', estimateClaudeUsd(workspace.settings.summaryModel, chars));
    const record = async (spent: { inputTokens: number; outputTokens: number }) => {
      const usd = usdFor('claude', workspace.settings.summaryModel, spent);
      await recordSpend('claude', usd);
      await addCost(meeting._id, {
        usd,
        claudeInputTokens: spent.inputTokens,
        claudeOutputTokens: spent.outputTokens,
      });
    };
    let outcome: Awaited<ReturnType<typeof deps.summariser.summarise>>;
    try {
      outcome = await deps.summariser.summarise({
        lines,
        glossary,
        languages: meeting.languages.length ? meeting.languages : workspace.settings.languages,
        includeNative: workspace.settings.scriptPreference === 'native',
        model: workspace.settings.summaryModel,
        meetingId: String(meeting._id),
      });
    } catch (err) {
      // calls that were paid for before the failure still count against the spend and the meeting's cost
      const spent = (err as { usage?: { inputTokens: number; outputTokens: number } }).usage;
      if (spent && (spent.inputTokens || spent.outputTokens)) await record(spent);
      throw err;
    }
    const { result, usage, error } = outcome;
    await record(usage);

    await MeetingModel.updateOne(
      { _id: meeting._id },
      {
        $set: result
          ? {
              summaryStatus: 'completed',
              summaryOutdated: false,
              // the names it was written with: a later rename is swapped into the text instead of a new summary
              summaryNames: (data?.speakerMap ?? null) as Record<string, string> | null,
              summary: result.summaryMarkdown,
              actionItems: result.actionItems,
              stage: 'finalise',
            }
          : { summaryStatus: 'failed', stage: 'finalise' },
      },
    );
    if (!result) log.warn({ error }, 'summary JSON invalid after retry');
    await enqueue({ meetingId: meeting._id, stage: 'finalise' });
  },

  /** A summariser outage should not hide the transcript: finish the meeting, offer a retry. */
  async onGiveUp({ job }: StageContext, error: Error) {
    await MeetingModel.updateOne(
      { _id: job.meetingId },
      {
        $set: {
          summaryStatus: 'failed',
          stage: 'finalise',
          error: { stage: 'summarise', message: humanizeError(error), retryable: true },
        },
      },
    );
    await enqueue({ meetingId: job.meetingId, stage: 'finalise' });
  },
};
