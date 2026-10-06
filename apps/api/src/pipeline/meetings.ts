import { Types } from 'mongoose';
import type { MeetingCost, Stage } from '@meetingid/shared';
import { MeetingDataModel, MeetingModel, WorkspaceModel, GlossaryModel } from '../models/index.js';
import { FatalError, humanizeError } from './errors.js';

export const oid = (id: string | Types.ObjectId): Types.ObjectId => new Types.ObjectId(String(id));

export async function loadMeeting(meetingId: string | Types.ObjectId) {
  const meeting = await MeetingModel.findById(oid(meetingId)).lean();
  if (!meeting) throw new FatalError(`Meeting ${String(meetingId)} not found`);
  return meeting;
}

export async function loadWorkspaceContext(workspaceId: Types.ObjectId) {
  const [workspace, glossary] = await Promise.all([
    WorkspaceModel.findById(workspaceId).lean(),
    GlossaryModel.findOne({ workspaceId }).lean(),
  ]);
  if (!workspace) throw new FatalError(`Workspace ${String(workspaceId)} not found`);
  return {
    workspace,
    glossary: glossary
      ? {
          entries: glossary.entries.map((e) => ({
            term: e.term,
            kind: e.kind,
            aliases: e.aliases ?? [],
            ...(e.note ? { note: e.note } : {}),
          })),
        }
      : null,
  };
}

/** Add provider usage to the meeting's running cost totals. */
export async function addCost(
  meetingId: Types.ObjectId,
  cost: Partial<MeetingCost>,
): Promise<void> {
  const inc: Record<string, number> = {};
  for (const [k, v] of Object.entries(cost)) if (v) inc[`cost.${k}`] = v;
  if (Object.keys(inc).length) await MeetingModel.updateOne({ _id: meetingId }, { $inc: inc });
}

/** Mark a meeting failed at `stage` with a human message; the UI offers "Retry stage". */
export async function failMeeting(
  meetingId: Types.ObjectId,
  stage: Stage,
  err: unknown,
  retryable = true,
): Promise<void> {
  await MeetingModel.updateOne(
    { _id: meetingId },
    { $set: { status: 'failed', stage, error: { stage, message: humanizeError(err), retryable } } },
  );
}

export async function loadChunkStatuses(meetingId: Types.ObjectId) {
  const data = await MeetingDataModel.findOne(
    { meetingId },
    { 'chunks.index': 1, 'chunks.status': 1, 'chunks.startSec': 1, 'chunks.endSec': 1 },
  ).lean();
  return data?.chunks ?? [];
}
