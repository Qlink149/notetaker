import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import { draftTask, isoDay } from '@meetingid/pipeline';
import {
  CreateTaskBody,
  PatchTaskBody,
  SetMeBody,
  type Task,
  type TaskSuggestion,
} from '@meetingid/shared';
import { ws } from '../lib/auth.js';
import { HttpError, body, idParam, notFound } from '../lib/http.js';
import {
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  TaskModel,
  WorkspaceModel,
  type MeetingDoc,
  type SpeakerCardDoc,
  type SpeakerDoc,
  type TaskDoc,
} from '../models/index.js';
import { displayName } from '../services/identity/identity.js';

/** Done tasks drop off the lists after this long. */
const DONE_KEPT_DAYS = 60;
/** Meetings whose action items are offered as suggested tasks: summaries written in this window. */
const SUGGEST_DAYS = 45;

type People = Map<string, SpeakerDoc>;

const people = async (workspaceId: Types.ObjectId): Promise<People> => {
  const list = await SpeakerModel.find({ workspaceId }, { voiceprints: 0 }).lean<SpeakerDoc[]>();
  return new Map(list.map((p) => [String(p._id), p]));
};

const nameOf = (pp: People, id: Types.ObjectId | null | undefined): string | null =>
  id ? (pp.get(String(id))?.name ?? 'Removed person') : null;

function taskView(t: TaskDoc, pp: People, meetings: Map<string, string>): Task {
  return {
    id: String(t._id),
    title: t.title,
    ownerId: t.ownerId ? String(t.ownerId) : null,
    ownerName: nameOf(pp, t.ownerId) ?? 'Unassigned',
    buddyId: t.buddyId ? String(t.buddyId) : null,
    buddyName: nameOf(pp, t.buddyId),
    priority: t.priority,
    due: t.due ?? null,
    status: t.status,
    doneAt: t.doneAt ? t.doneAt.toISOString() : null,
    createdById: t.createdById ? String(t.createdById) : null,
    createdByName: nameOf(pp, t.createdById),
    meetingId: t.meetingId ? String(t.meetingId) : null,
    meetingTitle: t.meetingId ? (meetings.get(String(t.meetingId)) ?? null) : null,
    source: t.source
      ? { meetingId: String(t.source.meetingId), index: t.source.index, text: t.source.text }
      : null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

async function viewAll(workspaceId: Types.ObjectId, tasks: TaskDoc[]): Promise<Task[]> {
  const pp = await people(workspaceId);
  const ids = [...new Set(tasks.filter((t) => t.meetingId).map((t) => String(t.meetingId)))];
  const ms = await MeetingModel.find(
    { _id: { $in: ids.map((i) => new Types.ObjectId(i)) } },
    { title: 1 },
  ).lean();
  const titles = new Map(ms.map((m) => [String(m._id), m.title]));
  return tasks.map((t) => taskView(t, pp, titles));
}

/** Identifies one written summary: a new summary gives new suggestions. */
const summaryKey = (m: Pick<MeetingDoc, 'summaryAt'>): string =>
  m.summaryAt ? new Date(m.summaryAt).toISOString() : 'before-tasks';

const handledOf = (m: Pick<MeetingDoc, 'summaryAt' | 'taskReview'>): Set<number> =>
  new Set(m.taskReview?.summaryKey === summaryKey(m) ? m.taskReview.handled : []);

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The person an action item's speaker name refers to: a voice of this meeting shown under that name, else a
 * named person in the directory with that name (or, when only one person has it, that first name).
 */
function ownerFor(name: string, cards: SpeakerCardDoc[], pp: People): string | null {
  const n = norm(name);
  for (const c of cards) {
    if (!c.personId) continue;
    const person = pp.get(c.personId);
    // "Speaker C" is not an assignment; only a named person is.
    if (!person || person.anonymous) continue;
    if (norm(displayName(c, pp)) === n) return c.personId;
  }
  const named = [...pp.values()].filter((p) => !p.anonymous);
  const exact = named.find((p) => norm(p.name) === n);
  if (exact) return String(exact._id);
  const byFirst = named.filter((p) => norm(p.name).split(' ')[0] === n);
  return byFirst.length === 1 ? String(byFirst[0]!._id) : null;
}

async function suggestionsFor(meetings: MeetingDoc[], pp: People): Promise<TaskSuggestion[]> {
  const out: TaskSuggestion[] = [];
  // An action item already made a task from this meeting is not offered again, even under a new summary (a
  // continuation rewrites the summary and keeps most of its action items).
  const made = await TaskModel.find(
    { meetingId: { $in: meetings.map((m) => m._id) }, source: { $ne: null } },
    { meetingId: 1, source: 1 },
  ).lean<TaskDoc[]>();
  const taken = new Set(made.map((t) => `${String(t.meetingId)}|${norm(t.source!.text)}`));
  for (const m of meetings) {
    if (!m.actionItems?.length) continue;
    const handled = handledOf(m);
    const pending = m.actionItems
      .map((a, i) => ({ a, i }))
      .filter(({ a, i }) => !handled.has(i) && !taken.has(`${String(m._id)}|${norm(a.text)}`));
    if (!pending.length) continue;
    const data = await MeetingDataModel.findOne({ meetingId: m._id }, { speakerCards: 1 }).lean();
    const cards = (data?.speakerCards ?? []) as SpeakerCardDoc[];
    const base = isoDay(new Date(m.date));
    for (const { a, i } of pending) {
      const d = draftTask(a.text, base);
      out.push({
        meetingId: String(m._id),
        meetingTitle: m.title,
        index: i,
        title: d.title,
        due: d.due,
        priority: d.priority,
        quote: d.quote,
        speakerName: a.speakerName,
        ownerId: ownerFor(a.speakerName, cards, pp),
      });
    }
  }
  return out;
}

/**
 * A suggestion whose speaker is a real person is the same as ticking it: it becomes a task. A voice that is
 * still only "Speaker …" stays in the list, because nobody has said who that is.
 */
async function acceptAssigned(
  workspaceId: Types.ObjectId,
  createdById: Types.ObjectId | null,
  suggestions: TaskSuggestion[],
): Promise<TaskSuggestion[]> {
  const open: TaskSuggestion[] = [];
  for (const s of suggestions) {
    if (!s.ownerId) {
      open.push(s);
      continue;
    }
    const meetingId = new Types.ObjectId(s.meetingId);
    const meeting = await MeetingModel.findById(meetingId, { actionItems: 1 }).lean<MeetingDoc>();
    const item = meeting?.actionItems?.[s.index];
    if (!item) continue;
    const made = await TaskModel.find(
      { meetingId, source: { $ne: null } },
      { source: 1 },
    ).lean<TaskDoc[]>();
    if (!made.some((t) => t.source && norm(t.source.text) === norm(item.text))) {
      await TaskModel.create({
        workspaceId,
        title: s.title,
        ownerId: new Types.ObjectId(s.ownerId),
        buddyId: null,
        priority: s.priority,
        due: s.due,
        createdById,
        meetingId,
        source: { meetingId, index: s.index, text: item.text },
      });
    }
    await markHandled(meetingId, s.index);
  }
  return open;
}

async function markHandled(meetingId: Types.ObjectId, index: number): Promise<void> {
  const m = await MeetingModel.findById(meetingId, { summaryAt: 1, taskReview: 1 }).lean();
  if (!m) return;
  const key = summaryKey(m);
  const handled = [...new Set([...handledOf(m), index])].sort((a, b) => a - b);
  await MeetingModel.updateOne(
    { _id: meetingId },
    { $set: { taskReview: { summaryKey: key, handled } } },
  );
}

/** "Kept" tasks: suggested from meetings' action items, approved, assigned and ticked off. */
export function tasksRouter(): Router {
  const r = Router();

  const personIn = async (req: Request, id: string | null | undefined): Promise<void> => {
    if (!id) return;
    if (!(await SpeakerModel.exists({ _id: id, workspaceId: ws(req)._id })))
      throw new HttpError(400, 'person_not_found');
  };
  const ownTask = async (req: Request): Promise<TaskDoc> => {
    const t = await TaskModel.findOne({
      _id: idParam(req),
      workspaceId: ws(req)._id,
    }).lean<TaskDoc>();
    if (!t) throw notFound('task_not_found');
    return t;
  };

  r.get('/tasks', async (req, res) => {
    const since = new Date(Date.now() - DONE_KEPT_DAYS * 86_400_000);
    const list = await TaskModel.find({
      workspaceId: ws(req)._id,
      $or: [{ status: 'open' }, { doneAt: { $gte: since } }],
    })
      .sort({ due: 1, createdAt: 1 })
      .lean<TaskDoc[]>();
    res.set('Cache-Control', 'no-store').json({ tasks: await viewAll(ws(req)._id, list) });
  });

  r.post('/tasks', async (req, res) => {
    const input = body(CreateTaskBody, req);
    const workspace = ws(req);
    await personIn(req, input.ownerId);
    await personIn(req, input.buddyId);
    let source: TaskDoc['source'] = null;
    let meetingId = input.meetingId ? new Types.ObjectId(input.meetingId) : null;
    if (input.fromSuggestion) {
      const m = await MeetingModel.findOne({
        _id: input.fromSuggestion.meetingId,
        workspaceId: workspace._id,
      }).lean<MeetingDoc>();
      const item = m?.actionItems?.[input.fromSuggestion.index];
      if (!m || !item) throw notFound('suggestion_not_found');
      if (handledOf(m).has(input.fromSuggestion.index))
        throw new HttpError(409, 'suggestion_already_handled');
      meetingId = m._id;
      source = { meetingId: m._id, index: input.fromSuggestion.index, text: item.text };
    } else if (
      meetingId &&
      !(await MeetingModel.exists({ _id: meetingId, workspaceId: workspace._id }))
    )
      throw notFound('meeting_not_found');
    const doc = await TaskModel.create({
      workspaceId: workspace._id,
      title: input.title,
      ownerId: new Types.ObjectId(input.ownerId),
      buddyId:
        input.buddyId && input.buddyId !== input.ownerId ? new Types.ObjectId(input.buddyId) : null,
      priority: input.priority,
      due: input.due ?? null,
      createdById: workspace.mePersonId ?? null,
      meetingId,
      source,
    });
    if (source) await markHandled(source.meetingId, source.index);
    const [view] = await viewAll(workspace._id, [doc.toObject() as TaskDoc]);
    res.status(201).json({ task: view });
  });

  r.patch('/tasks/:id', async (req, res) => {
    const t = await ownTask(req);
    const input = body(PatchTaskBody, req);
    await personIn(req, input.ownerId);
    await personIn(req, input.buddyId);
    const set: Record<string, unknown> = {};
    if (input.title !== undefined) set.title = input.title;
    if (input.priority !== undefined) set.priority = input.priority;
    if (input.due !== undefined) set.due = input.due;
    if (input.ownerId !== undefined) set.ownerId = new Types.ObjectId(input.ownerId);
    if (input.buddyId !== undefined)
      set.buddyId = input.buddyId ? new Types.ObjectId(input.buddyId) : null;
    const owner = String(set.ownerId ?? t.ownerId ?? '');
    const buddy = set.buddyId !== undefined ? set.buddyId : t.buddyId;
    if (buddy && String(buddy) === owner) set.buddyId = null;
    if (input.status !== undefined && input.status !== t.status) {
      set.status = input.status;
      set.doneAt = input.status === 'done' ? new Date() : null;
    }
    const updated = await TaskModel.findByIdAndUpdate(
      t._id,
      { $set: set },
      { returnDocument: 'after' },
    ).lean<TaskDoc>();
    const [view] = await viewAll(ws(req)._id, [updated!]);
    res.json({ task: view });
  });

  r.delete('/tasks/:id', async (req, res) => {
    const t = await ownTask(req);
    await TaskModel.deleteOne({ _id: t._id });
    res.status(204).end();
  });

  /** Action items of recent meetings not yet approved or skipped, newest meeting first. */
  r.get('/task-suggestions', async (req, res) => {
    const since = new Date(Date.now() - SUGGEST_DAYS * 86_400_000);
    const meetings = await MeetingModel.find({
      workspaceId: ws(req)._id,
      summaryStatus: 'completed',
      'actionItems.0': { $exists: true },
      $or: [{ summaryAt: { $gte: since } }, { summaryAt: null, date: { $gte: since } }],
    })
      .sort({ date: -1 })
      .lean<MeetingDoc[]>();
    const workspace = ws(req);
    const pp = await people(workspace._id);
    const suggestions = await acceptAssigned(
      workspace._id,
      workspace.mePersonId ?? null,
      await suggestionsFor(meetings, pp),
    );
    res.set('Cache-Control', 'no-store').json({ suggestions });
  });

  r.get('/meetings/:id/task-suggestions', async (req, res) => {
    const m = await MeetingModel.findOne({
      _id: idParam(req),
      workspaceId: ws(req)._id,
    }).lean<MeetingDoc>();
    if (!m) throw notFound('meeting_not_found');
    const workspace = ws(req);
    const pp = await people(workspace._id);
    const suggestions = await acceptAssigned(
      workspace._id,
      workspace.mePersonId ?? null,
      await suggestionsFor([m], pp),
    );
    res.set('Cache-Control', 'no-store').json({ suggestions });
  });

  /** "Skip" on a suggested task: it is not offered again for this summary. */
  r.post('/meetings/:id/task-suggestions/:index/skip', async (req, res) => {
    const m = await MeetingModel.findOne({
      _id: idParam(req),
      workspaceId: ws(req)._id,
    }).lean<MeetingDoc>();
    const index = Number(req.params.index);
    if (!m || !Number.isInteger(index) || !m.actionItems?.[index])
      throw notFound('suggestion_not_found');
    await markHandled(m._id, index);
    res.status(204).end();
  });

  /** Who "me" is in this workspace: "my tasks", "delegated" and who gave a task. */
  r.put('/workspace/me', async (req, res) => {
    const { personId } = body(SetMeBody, req);
    await personIn(req, personId);
    await WorkspaceModel.updateOne(
      { _id: ws(req)._id },
      { $set: { mePersonId: personId ? new Types.ObjectId(personId) : null } },
    );
    res.json({ mePersonId: personId });
  });

  return r;
}
