import { draftTask, type TaskPriority } from './tasks.js';

/**
 * What a refreshed summary does to tasks already filed from this meeting.
 *
 * A task still in the shape of its suggestion (open, no buddy, title, due and priority unchanged, and still
 * owned by the speaker the action item named) follows the new action items: the same wording moves to the
 * speaker who has it now. If that person is no longer in the meeting and the wording is gone, or nobody owns
 * it any more, the task is dropped so it leaves their list and this meeting. A completed task, a task someone
 * edited, a task they assigned to someone else, and a task added by hand are left as they are.
 */
export interface ReconcileTask {
  id: string;
  title: string;
  ownerId: string | null;
  buddyId: string | null;
  priority: TaskPriority;
  due: string | null;
  status: 'open' | 'done';
  /** Action-item text this task was filed from. Null when someone added the task by hand. */
  sourceText: string | null;
}

export interface ReconcileItem {
  speakerName: string;
  text: string;
  /** Person that speaker name is, in this meeting or the directory. */
  ownerId: string | null;
}

export type ReconcileOp =
  | { id: string; op: 'keep' }
  | { id: string; op: 'reassign'; ownerId: string; sourceIndex: number }
  | { id: string; op: 'drop' };

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

function findItem(
  items: readonly ReconcileItem[],
  text: string,
): { item: ReconcileItem; index: number } | null {
  const n = norm(text);
  const index = items.findIndex((a) => norm(a.text) === n);
  if (index < 0) return null;
  return { item: items[index]!, index };
}

export function reconcileMeetingTasks(input: {
  tasks: readonly ReconcileTask[];
  /** Action items before this summary change. */
  previous: readonly ReconcileItem[];
  /** Action items the summary has now. */
  next: readonly ReconcileItem[];
  /** People who still have a voice in this meeting. */
  presentPersonIds: readonly string[];
  /** The meeting's day, YYYY-MM-DD, so a filed task can be compared with the suggestion it came from. */
  meetingDay: string;
}): ReconcileOp[] {
  const present = new Set(input.presentPersonIds);
  return input.tasks.map((task): ReconcileOp => {
    if (!task.sourceText) return { id: task.id, op: 'keep' };
    const draft = draftTask(task.sourceText, input.meetingDay);
    const filedAsIs =
      task.status === 'open' &&
      task.buddyId == null &&
      task.title === draft.title &&
      (task.due ?? null) === (draft.due ?? null) &&
      task.priority === draft.priority;
    if (!filedAsIs) return { id: task.id, op: 'keep' };

    const prev = findItem(input.previous, task.sourceText);
    const autoOwner = prev?.item.ownerId ?? null;
    // The owner is not the person the action item named: someone chose them, so the task stays theirs.
    const ownerChosen =
      prev != null &&
      ((autoOwner == null && task.ownerId != null) ||
        (autoOwner != null && task.ownerId !== autoOwner));
    if (ownerChosen) return { id: task.id, op: 'keep' };

    const nxt = findItem(input.next, task.sourceText);
    if (nxt?.item.ownerId && nxt.item.ownerId !== task.ownerId)
      return {
        id: task.id,
        op: 'reassign',
        ownerId: nxt.item.ownerId,
        sourceIndex: nxt.index,
      };
    if (nxt && nxt.item.ownerId === task.ownerId) return { id: task.id, op: 'keep' };
    const ownerHere = task.ownerId != null && present.has(task.ownerId);
    if (!ownerHere && (!nxt || nxt.item.ownerId == null)) return { id: task.id, op: 'drop' };
    return { id: task.id, op: 'keep' };
  });
}
