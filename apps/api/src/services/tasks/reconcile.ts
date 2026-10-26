import { Types } from 'mongoose';
import { isoDay, reconcileMeetingTasks, type ReconcileItem } from '@meetingid/pipeline';
import {
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  TaskModel,
  type SpeakerCardDoc,
  type SpeakerDoc,
  type TaskDoc,
} from '../../models/index.js';
import { displayName } from '../identity/display.js';

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The person an action item's speaker name refers to: a voice of this meeting shown under that name, else a
 * named person in the directory with that name (or, when only one person has it, that first name).
 */
export function speakerOwnerId(
  name: string,
  cards: SpeakerCardDoc[],
  pp: Map<string, SpeakerDoc>,
): string | null {
  const n = norm(name);
  for (const c of cards) if (c.personId && norm(displayName(c, pp)) === n) return c.personId;
  const named = [...pp.values()].filter((p) => !p.anonymous);
  const exact = named.find((p) => norm(p.name) === n);
  if (exact) return String(exact._id);
  const byFirst = named.filter((p) => norm(p.name).split(' ')[0] === n);
  return byFirst.length === 1 ? String(byFirst[0]!._id) : null;
}

export interface TaskFollowResult {
  reassigned: number;
  dropped: number;
}

/**
 * Point this meeting's filed tasks at the speakers its action items name now.
 * Other meetings are not read. See `reconcileMeetingTasks` for what is left untouched.
 */
export async function applyMeetingTaskFollow(
  meetingId: string,
  previous: { speakerName: string; text: string }[],
  next: { speakerName: string; text: string }[],
): Promise<TaskFollowResult> {
  const meeting = await MeetingModel.findById(meetingId).lean();
  if (!meeting) return { reassigned: 0, dropped: 0 };
  const [tasks, data, people] = await Promise.all([
    TaskModel.find({
      workspaceId: meeting.workspaceId,
      meetingId: meeting._id,
    }).lean<TaskDoc[]>(),
    MeetingDataModel.findOne({ meetingId: meeting._id }, { speakerCards: 1 }).lean(),
    SpeakerModel.find({ workspaceId: meeting.workspaceId }, { voiceprints: 0 }).lean<
      SpeakerDoc[]
    >(),
  ]);
  if (!tasks.length) return { reassigned: 0, dropped: 0 };
  const cards = (data?.speakerCards ?? []) as SpeakerCardDoc[];
  const pp = new Map(people.map((p) => [String(p._id), p]));
  const resolve = (items: { speakerName: string; text: string }[]): ReconcileItem[] =>
    items.map((a) => ({
      speakerName: a.speakerName,
      text: a.text,
      ownerId: speakerOwnerId(a.speakerName, cards, pp),
    }));
  const presentPersonIds = cards.map((c) => c.personId).filter((id): id is string => !!id);
  const ops = reconcileMeetingTasks({
    tasks: tasks.map((t) => ({
      id: String(t._id),
      title: t.title,
      ownerId: t.ownerId ? String(t.ownerId) : null,
      buddyId: t.buddyId ? String(t.buddyId) : null,
      priority: t.priority,
      due: t.due ?? null,
      status: t.status,
      sourceText: t.source?.text ?? null,
    })),
    previous: resolve(previous),
    next: resolve(next),
    presentPersonIds,
    meetingDay: isoDay(new Date(meeting.date)),
  });
  let reassigned = 0;
  let dropped = 0;
  for (const op of ops) {
    const _id = new Types.ObjectId(op.id);
    switch (op.op) {
      case 'keep':
        break;
      case 'reassign':
        await TaskModel.updateOne(
          { _id, meetingId: meeting._id },
          { $set: { ownerId: new Types.ObjectId(op.ownerId), 'source.index': op.sourceIndex } },
        );
        reassigned += 1;
        break;
      case 'drop':
        await TaskModel.deleteOne({ _id, meetingId: meeting._id });
        dropped += 1;
        break;
      default: {
        const neverOp: never = op;
        return neverOp;
      }
    }
  }
  return { reassigned, dropped };
}
