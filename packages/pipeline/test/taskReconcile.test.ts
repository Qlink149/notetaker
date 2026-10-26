import { describe, expect, it } from 'vitest';
import { draftTask } from '../src/tasks.js';
import {
  reconcileMeetingTasks,
  type ReconcileItem,
  type ReconcileTask,
} from '../src/taskReconcile.js';

const day = '2026-10-24';
const text = 'Send the samples by tomorrow';
const draft = draftTask(text, day);

const item = (speakerName: string, ownerId: string | null, wording = text): ReconcileItem => ({
  speakerName,
  text: wording,
  ownerId,
});

const task = (over: Partial<ReconcileTask> = {}): ReconcileTask => ({
  id: 't1',
  title: draft.title,
  ownerId: 'harshit',
  buddyId: null,
  priority: draft.priority,
  due: draft.due,
  status: 'open',
  sourceText: text,
  ...over,
});

const run = (
  tasks: ReconcileTask[],
  over: {
    previous?: ReconcileItem[];
    next?: ReconcileItem[];
    presentPersonIds?: string[];
  } = {},
) =>
  reconcileMeetingTasks({
    tasks,
    previous: over.previous ?? [item('Harshit', 'harshit')],
    next: over.next ?? [item('Priya', 'priya')],
    presentPersonIds: over.presentPersonIds ?? ['priya'],
    meetingDay: day,
  });

describe('reconcileMeetingTasks', () => {
  it('moves an untouched task onto the speaker the new summary gives it to', () => {
    expect(run([task()])).toEqual([{ id: 't1', op: 'reassign', ownerId: 'priya', sourceIndex: 0 }]);
  });

  it('drops an untouched task when that person has left and the action item is gone', () => {
    expect(
      run([task({ id: 'gone' })], {
        next: [item('Priya', 'priya', 'Book the hall')],
      }),
    ).toEqual([{ id: 'gone', op: 'drop' }]);
  });

  it('drops an untouched task when the new wording has no owner and the old owner has left', () => {
    expect(run([task()], { next: [item('Speaker B', null)] })).toEqual([{ id: 't1', op: 'drop' }]);
  });

  it('keeps a completed task, a hand edit, a chosen owner, and a task added by hand', () => {
    const tasks = [
      task({ id: 'done', status: 'done' }),
      task({ id: 'title', title: 'Send the dyed samples' }),
      task({ id: 'buddy', buddyId: 'raju' }),
      task({ id: 'due', due: '2026-11-01' }),
      task({ id: 'picked', ownerId: 'raju' }),
      task({ id: 'hand', sourceText: null, ownerId: 'harshit' }),
    ];
    expect(run(tasks).map((op) => op.op)).toEqual(['keep', 'keep', 'keep', 'keep', 'keep', 'keep']);
  });

  it('keeps an untouched task whose owner is still in the meeting when the wording changed', () => {
    expect(
      run([task()], {
        next: [item('Priya', 'priya', 'Book the hall')],
        presentPersonIds: ['harshit', 'priya'],
      }),
    ).toEqual([{ id: 't1', op: 'keep' }]);
  });

  it('leaves a task whose speaker did not change', () => {
    expect(
      run([task({ ownerId: 'priya' })], {
        previous: [item('Priya', 'priya')],
        presentPersonIds: ['priya'],
      }),
    ).toEqual([{ id: 't1', op: 'keep' }]);
  });
});
