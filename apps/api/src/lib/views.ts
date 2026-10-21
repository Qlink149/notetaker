import type { EvalRun, Meeting, MeetingDataView, Workspace } from '@meetingid/shared';
import { DEFAULT_FOLDERS, emptyCost } from '@meetingid/shared';
import type { EvalRunDoc, MeetingDataDoc, MeetingDoc, WorkspaceDoc } from '../models/index.js';
import { audioLink } from './audioLink.js';
import { isB2Url } from '../services/storage/b2.js';

/** Where the browser plays a meeting from: a signed link for private storage, else the stored link. */
export function playbackUrlOf(m: {
  audio: { originalUrl: string; originalPublicId: string; playbackUrl?: string | null };
}): string | null {
  return isB2Url(m.audio.originalUrl)
    ? audioLink(m.audio.originalPublicId)
    : (m.audio.playbackUrl ?? null);
}

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
      playbackUrl: playbackUrlOf(m),
      analysisUrl: m.audio.analysisUrl ?? null,
      analysisPublicId: m.audio.analysisPublicId ?? null,
      ...(m.audio.parts?.length
        ? {
            parts: m.audio.parts.map((p) => ({
              publicId: p.publicId,
              url: p.url,
              fileName: p.fileName ?? null,
              durationSec: p.durationSec ?? null,
              offsetSec: p.offsetSec ?? null,
            })),
          }
        : {}),
    },
    coverage: m.coverage ?? null,
    participants: m.participants ?? [],
    unknownCount: m.unknownCount ?? 0,
    summaryStatus: m.summaryStatus,
    summaryOutdated: m.summaryOutdated === true,
    audioWarning: m.audioWarning ?? null,
    notice: m.notice ?? null,
    summary: m.summary ?? null,
    actionItems: (m.actionItems ?? []).map((a) => ({ speakerName: a.speakerName, text: a.text })),
    folder: m.folder ?? null,
    drive: m.drive
      ? {
          fileId: m.drive.fileId,
          url: m.drive.url,
          folder: m.drive.folder ?? null,
          savedAt: iso(m.drive.savedAt),
        }
      : null,
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

/** The workspace's meeting folders (the defaults until someone changes them). */
export const foldersOf = (w: Pick<WorkspaceDoc, 'folders'>): string[] =>
  w.folders ?? [...DEFAULT_FOLDERS];

export function workspaceView(w: WorkspaceDoc): Workspace {
  return {
    id: String(w._id),
    name: w.name,
    slug: w.slug,
    settings: w.settings,
    mePersonId: w.mePersonId ? String(w.mePersonId) : null,
    folders: foldersOf(w),
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
