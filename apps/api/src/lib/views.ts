import type { EvalRun, Meeting, MeetingDataView, Workspace } from '@meetingid/shared';
import { emptyCost } from '@meetingid/shared';
import type { EvalRunDoc, MeetingDataDoc, MeetingDoc, WorkspaceDoc } from '../models/index.js';

const iso = (d: Date | string | null | undefined): string =>
  d ? new Date(d).toISOString() : new Date(0).toISOString();

/** The small meeting record the UI polls. Never includes per-turn data. */
export function meetingView(m: MeetingDoc): Meeting {
  return {
    id: String(m._id),
    workspaceId: String(m.workspaceId),
    title: m.title,
    date: iso(m.date),
    durationSec: m.durationSec ?? null,
    status: m.status,
    stage: m.stage,
    progress: {
      chunksTotal: m.progress?.chunksTotal ?? 0,
      chunksDone: m.progress?.chunksDone ?? 0,
    },
    engine: m.engine,
    languages: m.languages ?? [],
    expectedParticipants: m.expectedParticipants ?? null,
    audio: {
      originalUrl: m.audio.originalUrl,
      originalPublicId: m.audio.originalPublicId,
      playbackUrl: m.audio.playbackUrl ?? null,
      analysisUrl: m.audio.analysisUrl ?? null,
      analysisPublicId: m.audio.analysisPublicId ?? null,
    },
    coverage: m.coverage ?? null,
    participants: m.participants ?? [],
    unknownCount: m.unknownCount ?? 0,
    summaryStatus: m.summaryStatus,
    summary: m.summary ?? null,
    actionItems: (m.actionItems ?? []).map((a) => ({ speakerName: a.speakerName, text: a.text })),
    error: m.error ?? null,
    cost: { ...emptyCost(), ...(m.cost ?? {}) },
    createdAt: iso(m.createdAt),
    updatedAt: iso(m.updatedAt),
  };
}

export function meetingDataView(
  d: Pick<MeetingDataDoc, 'meetingId' | 'turns' | 'lines' | 'speakerMap'>,
  m: MeetingDoc,
): MeetingDataView {
  return {
    meetingId: String(d.meetingId),
    turns: d.turns ?? [],
    lines: d.lines ?? [],
    speakerMap: d.speakerMap ?? {},
    coverage: m.coverage ?? null,
  };
}

export function workspaceView(w: WorkspaceDoc): Workspace {
  return {
    id: String(w._id),
    name: w.name,
    slug: w.slug,
    settings: w.settings,
    createdAt: iso(w.createdAt),
  };
}

export function evalRunView(r: EvalRunDoc): EvalRun {
  return {
    id: String(r._id),
    workspaceId: String(r.workspaceId),
    evalSetId: r.evalSetId ? String(r.evalSetId) : null,
    engines: r.engines,
    meetingIds: r.meetingIds.map(String),
    status: r.status,
    results: r.results.map((x) => ({
      meetingId: String(x.meetingId),
      engine: x.engine,
      model: x.model,
      status: x.status,
      error: x.error ?? null,
      coverage: x.coverage ?? null,
      turns: x.turns,
      words: x.words,
      durationMs: x.durationMs,
      costTokens: x.costTokens,
      transcriptLines: x.transcriptLines ?? [],
    })),
    createdAt: iso(r.createdAt),
  };
}
