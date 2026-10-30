import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import {
  JobModel,
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  SpeakerUndoModel,
  TaskModel,
  WorkspaceModel,
  type SpeakerDoc,
  type SpeakerUndoDoc,
  type SpeakerUndoMeetingSnap,
} from '../../models/index.js';
import { EditError, mergePeople } from './edits.js';

export { EditError };
import { applyNames, meetingsOfPerson, renamePerson } from './identity.js';

/**
 * Global voice assignment (the Speakers page).
 *
 * Assigning a voice to an existing person merges the two profiles: voiceprints move onto the
 * person, every past meeting that used the voice shows that person's name, and later meetings
 * compare the voice as that person because the voiceprints now live on their profile.
 * "Add new" renames this profile in place (same id, so the voiceprints stay) unless that name
 * already belongs to someone, in which case the caller is told to merge instead.
 *
 * Undo window: `SPEAKER_UNDO_MINUTES` (default 10). The undo record is written BEFORE the change, so a crash
 * halfway can still be put back, and it names exactly what the change added. Undo takes those things away
 * again, by id, instead of writing an old copy of the profile over it: a voice learned onto the person, or a
 * name changed, since the merge is kept. Undo is refused while a newer change to the same people is still open
 * ("undo that one first"), and while a meeting is being processed. Summaries are put back unless a new
 * summary was written in the meantime. After the window the record stays for a day so a late click can say
 * the undo has expired, then it is deleted with the copy of the merged profile.
 */

export class NameExistsError extends Error {
  readonly matches: PersonRef[];
  constructor(matches: PersonRef[]) {
    super('name_exists');
    this.name = 'NameExistsError';
    this.matches = matches;
  }
}

export class UndoError extends Error {
  constructor(
    readonly status: 404 | 409 | 410,
    message: string,
  ) {
    super(message);
    this.name = 'UndoError';
  }
}

export interface PersonRef {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
}

export interface AssignPreview {
  needsConfirmation: true;
  action: 'merge' | 'rename';
  undoMinutes: number;
  meetings: number;
  source: { id: string; name: string };
  target?: PersonRef;
  name?: string;
}

export interface AssignDone {
  needsConfirmation: false;
  action: 'merge' | 'rename';
  undoId: string;
  expiresAt: string;
  undoMinutes: number;
  meetings: string[];
  label: string;
}

export type AssignResult = AssignPreview | AssignDone;

export interface OpenUndo {
  id: string;
  expiresAt: string;
  label: string;
  kind: 'merge' | 'rename';
}

/** Trim ends and collapse inner spaces. Empty after that is not a name. */
export function cleanPersonName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** Case-insensitive, after the same trim. "Parag" and " parag " are the same name. */
export function samePersonName(a: string, b: string): boolean {
  return cleanPersonName(a).toLowerCase() === cleanPersonName(b).toLowerCase();
}

export function undoWindowMs(): number {
  return env().SPEAKER_UNDO_MINUTES * 60 * 1000;
}

/**
 * Merging, renaming, deleting and undoing change who the voices of a meeting belong to. A meeting that is
 * being processed has identify and learn jobs holding the old people's labels, and would write a card for a
 * person who is gone. So these wait until nothing is running.
 */
export async function assertNothingProcessing(): Promise<void> {
  const busy = await JobModel.exists({
    status: { $in: ['queued', 'running'] },
    stage: { $ne: 'benchmark' },
  });
  if (busy) throw new BusyError();
}

export class BusyError extends Error {
  constructor() {
    super('A meeting is being processed. Try again when it has finished.');
    this.name = 'BusyError';
  }
}

const personRef = (p: SpeakerDoc): PersonRef => ({
  id: String(p._id),
  name: p.name,
  email: p.email ?? null,
  role: p.role ?? null,
});

async function personIn(workspaceId: string, personId: string): Promise<SpeakerDoc> {
  if (!Types.ObjectId.isValid(personId)) throw new EditError('Unknown person.');
  const person = await SpeakerModel.findOne({
    _id: personId,
    workspaceId: new Types.ObjectId(workspaceId),
  }).lean<SpeakerDoc>();
  if (!person) throw new EditError('Unknown person.');
  return person;
}

async function matchesFor(
  workspaceId: string,
  name: string,
  exceptId: string,
): Promise<PersonRef[]> {
  const people = await SpeakerModel.find({
    workspaceId: new Types.ObjectId(workspaceId),
  }).lean<SpeakerDoc[]>();
  return people
    .filter((p) => String(p._id) !== exceptId && samePersonName(p.name, name))
    .map(personRef);
}

async function meetingSnaps(meetingIds: string[]): Promise<SpeakerUndoMeetingSnap[]> {
  if (!meetingIds.length) return [];
  const docs = await MeetingModel.find(
    { _id: { $in: meetingIds } },
    { summary: 1, actionItems: 1, summaryNames: 1, summaryOutdated: 1, summaryAt: 1 },
  ).lean();
  return docs.map((m) => ({
    meetingId: m._id,
    summary: m.summary ?? null,
    actionItems: m.actionItems ?? [],
    summaryNames: (m.summaryNames as Record<string, string> | null) ?? null,
    summaryOutdated: m.summaryOutdated ?? false,
    summaryAt: m.summaryAt ?? null,
  }));
}

async function taskIdsOf(personId: string): Promise<SpeakerUndoDoc['taskIds']> {
  const id = new Types.ObjectId(personId);
  const [owner, buddy, createdBy] = await Promise.all([
    TaskModel.find({ ownerId: id }, { _id: 1 }).lean(),
    TaskModel.find({ buddyId: id }, { _id: 1 }).lean(),
    TaskModel.find({ createdById: id }, { _id: 1 }).lean(),
  ]);
  return {
    owner: owner.map((t) => t._id),
    buddy: buddy.map((t) => t._id),
    createdBy: createdBy.map((t) => t._id),
  };
}

/** The tasks of these meetings as they are now (a name change moves tasks with the summary, or drops them). */
async function tasksOfMeetings(meetingIds: string[]): Promise<Record<string, unknown>[]> {
  if (!meetingIds.length) return [];
  return (await TaskModel.find({ meetingId: { $in: meetingIds } }).lean()) as unknown as Record<
    string,
    unknown
  >[];
}

function copySpeaker(p: SpeakerDoc): SpeakerDoc {
  return {
    _id: p._id,
    workspaceId: p.workspaceId,
    name: p.name,
    aliases: [...(p.aliases ?? [])],
    anonymous: p.anonymous ?? false,
    origin: p.origin ?? null,
    voiceprints: (p.voiceprints ?? []).map((v) => ({ ...v })),
    ignoreMeetings: [...(p.ignoreMeetings ?? [])],
    mainSampleId: p.mainSampleId ?? null,
    email: p.email ?? null,
    role: p.role ?? null,
    leftAt: p.leftAt ?? null,
    createdAt: p.createdAt,
  };
}

async function cardsOf(
  personId: string,
): Promise<{ meetingId: Types.ObjectId; diar: string }[]> {
  const docs = await MeetingDataModel.find(
    { 'speakerCards.personId': personId },
    { meetingId: 1, speakerCards: 1 },
  ).lean();
  const out: { meetingId: Types.ObjectId; diar: string }[] = [];
  for (const d of docs) {
    for (const c of d.speakerCards ?? []) {
      if (c.personId === personId) out.push({ meetingId: d.meetingId, diar: c.diar });
    }
  }
  return out;
}

/**
 * Put the written summaries back. A meeting whose summary was written again since the change (`summaryAt` is
 * no longer the one that was snapshotted) keeps the new one.
 */
async function restoreSummaries(snaps: SpeakerUndoMeetingSnap[]): Promise<number> {
  let kept = 0;
  for (const s of snaps) {
    const r = await MeetingModel.updateOne(
      { _id: s.meetingId, summaryAt: s.summaryAt ?? null },
      {
        $set: {
          summary: s.summary,
          actionItems: s.actionItems,
          summaryNames: s.summaryNames,
          summaryOutdated: s.summaryOutdated,
        },
      },
    );
    if (!r.matchedCount) kept += 1;
  }
  return kept;
}

/** Cards that the change moved to `fromId` point at `toId` again; a card someone changed since is left. */
async function relinkCards(
  cards: { meetingId: Types.ObjectId; diar: string }[],
  fromId: string,
  toId: string,
): Promise<void> {
  for (const card of cards) {
    await MeetingDataModel.updateOne(
      { meetingId: card.meetingId },
      { $set: { 'speakerCards.$[c].personId': toId } },
      { arrayFilters: [{ 'c.diar': card.diar, 'c.personId': fromId }] },
    );
  }
}

/** Tasks the change reassigned or dropped go back as they were; others are not touched. */
async function restoreMeetingTasks(tasks: Record<string, unknown>[]): Promise<void> {
  for (const t of tasks) {
    const _id = t._id as Types.ObjectId;
    // a dropped task is put back whole...
    await TaskModel.updateOne({ _id }, { $setOnInsert: t }, { upsert: true, timestamps: false });
    // ...and a moved one gets its owner and place back
    const index = (t.source as { index?: number } | undefined)?.index;
    await TaskModel.updateOne(
      { _id },
      {
        $set: {
          ownerId: (t.ownerId as Types.ObjectId | null | undefined) ?? null,
          ...(index !== undefined ? { 'source.index': index } : {}),
        },
      },
      { timestamps: false },
    );
  }
}

/**
 * Point `sourceId` at an existing person (`personId`) or give it a new name (`name`).
 * Nothing is written unless `confirm` is true. A name that already exists (case-insensitive,
 * after trim) throws `NameExistsError` so the caller can merge into that person instead.
 */
export async function assignVoice(
  workspaceId: string,
  sourceId: string,
  input: { personId?: string; name?: string; confirm?: boolean },
): Promise<AssignResult> {
  const confirm = input.confirm === true;
  const hasId = Boolean(input.personId);
  const hasName = input.name !== undefined;
  if (hasId === hasName) throw new EditError('Choose a person, or type a new name.');
  const source = await personIn(workspaceId, sourceId);
  const workspace = await WorkspaceModel.findById(workspaceId).lean();
  if (workspace?.mePersonId && String(workspace.mePersonId) === String(source._id)) {
    throw new EditError(
      'This profile is “This is me”. Assign a different voice — merging it would change who can use this page.',
    );
  }
  const minutes = env().SPEAKER_UNDO_MINUTES;

  if (input.personId) {
    const target = await personIn(workspaceId, input.personId);
    if (String(target._id) === String(source._id))
      throw new EditError('That voice is already this person.');
    const meetings = await meetingsOfPerson(String(source._id));
    if (!confirm) {
      return {
        needsConfirmation: true,
        action: 'merge',
        undoMinutes: minutes,
        meetings: meetings.length,
        source: { id: String(source._id), name: source.name },
        target: personRef(target),
      };
    }
    await assertNothingProcessing();
    const undo = await commitMerge(workspaceId, source, target, meetings);
    return { needsConfirmation: false, ...undo, undoMinutes: minutes };
  }

  const name = cleanPersonName(input.name ?? '');
  if (!name) throw new EditError('Enter a name.');
  if (name.length > 100) throw new EditError('That name is too long.');
  // only the exact same name is refused: "parag" to "Parag" is a fix, and is allowed
  if (cleanPersonName(source.name) === name && source.anonymous !== true) {
    throw new EditError('That voice already has this name.');
  }
  const matches = await matchesFor(workspaceId, name, String(source._id));
  if (matches.length) throw new NameExistsError(matches);
  const meetings = await meetingsOfPerson(String(source._id));
  if (!confirm) {
    return {
      needsConfirmation: true,
      action: 'rename',
      undoMinutes: minutes,
      meetings: meetings.length,
      source: { id: String(source._id), name: source.name },
      name,
    };
  }
  await assertNothingProcessing();
  const undo = await commitRename(workspaceId, source, name, meetings);
  return { needsConfirmation: false, ...undo, undoMinutes: minutes };
}

async function commitMerge(
  workspaceId: string,
  source: SpeakerDoc,
  target: SpeakerDoc,
  meetings: string[],
): Promise<Omit<AssignDone, 'needsConfirmation' | 'undoMinutes'>> {
  const sourceId = String(source._id);
  const [cards, tasks, snaps, meetingTasks, meMoved] = await Promise.all([
    cardsOf(sourceId),
    taskIdsOf(sourceId),
    meetingSnaps(meetings),
    tasksOfMeetings(meetings),
    WorkspaceModel.exists({
      _id: new Types.ObjectId(workspaceId),
      mePersonId: source._id,
    }),
  ]);
  // what the merge will add to the survivor, worked out the way `mergePeople` adds it
  const has = new Set((target.voiceprints ?? []).map((v) => v.id));
  const addedVoiceprintIds = (source.voiceprints ?? []).map((v) => v.id).filter((id) => !has.has(id));
  const ignored = new Set((target.ignoreMeetings ?? []).map(String));
  const addedIgnoreMeetings = (source.ignoreMeetings ?? []).filter((m) => !ignored.has(String(m)));
  const addedAlias =
    !source.anonymous && !(target.aliases ?? []).includes(source.name) ? source.name : null;
  const label = `Merged “${source.name}” into ${target.name}`;
  // The record goes first: if the merge stops halfway, it can still be put back.
  const doc = await SpeakerUndoModel.create({
    workspaceId: new Types.ObjectId(workspaceId),
    kind: 'merge',
    expiresAt: new Date(Date.now() + undoWindowMs()),
    undoneAt: null,
    sourceId: source._id,
    source: copySpeaker(source),
    targetId: target._id,
    addedVoiceprintIds,
    addedIgnoreMeetings,
    addedAlias,
    mainBefore: target.mainSampleId ?? null,
    mainPinned: null,
    previousName: null,
    previousAnonymous: null,
    newName: null,
    cards,
    taskIds: tasks,
    meetingTasks,
    meMoved: Boolean(meMoved),
    meetings: snaps,
    label,
  });
  let affected: string[];
  try {
    affected = await mergePeople(String(target._id), sourceId);
    // `mergePeople` pins the survivor's voice before the other's samples join; undo lets go of that pin again
    const now = await SpeakerModel.findById(target._id, { mainSampleId: 1 }).lean();
    if (now?.mainSampleId && now.mainSampleId !== (target.mainSampleId ?? null))
      await SpeakerUndoModel.updateOne({ _id: doc._id }, { $set: { mainPinned: now.mainSampleId } });
  } catch (err) {
    try {
      await undoMerge(doc.toObject() as SpeakerUndoDoc);
      await SpeakerUndoModel.deleteOne({ _id: doc._id });
    } catch (rollback) {
      logger.error(
        { undoId: String(doc._id), err: String(rollback) },
        'voice merge failed and could not be put back; the undo record is kept',
      );
    }
    throw err;
  }
  return {
    action: 'merge',
    undoId: String(doc._id),
    expiresAt: doc.expiresAt.toISOString(),
    meetings: affected,
    label,
  };
}

async function commitRename(
  workspaceId: string,
  source: SpeakerDoc,
  name: string,
  meetings: string[],
): Promise<Omit<AssignDone, 'needsConfirmation' | 'undoMinutes'>> {
  const [snaps, meetingTasks] = await Promise.all([meetingSnaps(meetings), tasksOfMeetings(meetings)]);
  const label = `Named “${source.name}” as ${name}`;
  const doc = await SpeakerUndoModel.create({
    workspaceId: new Types.ObjectId(workspaceId),
    kind: 'rename',
    expiresAt: new Date(Date.now() + undoWindowMs()),
    undoneAt: null,
    sourceId: source._id,
    source: null,
    targetId: null,
    addedVoiceprintIds: [],
    addedIgnoreMeetings: [],
    addedAlias: null,
    mainBefore: null,
    mainPinned: null,
    previousName: source.name,
    previousAnonymous: source.anonymous ?? false,
    newName: name,
    cards: [],
    taskIds: { owner: [], buddy: [], createdBy: [] },
    meetingTasks,
    meMoved: false,
    meetings: snaps,
    label,
  });
  let renamed: { meetings: string[] };
  try {
    renamed = await renamePerson(String(source._id), name);
  } catch (err) {
    try {
      const now = await SpeakerModel.findById(source._id, { name: 1 }).lean();
      // nothing was written when the name was refused (taken by someone in the meantime): only the record goes
      if (now && now.name !== source.name) await undoRename(doc.toObject() as SpeakerUndoDoc);
      await SpeakerUndoModel.deleteOne({ _id: doc._id });
      if ((err as { code?: number }).code === 11000)
        throw new NameExistsError(await matchesFor(workspaceId, name, String(source._id)));
    } catch (rollback) {
      if (rollback instanceof NameExistsError) throw rollback;
      logger.error(
        { undoId: String(doc._id), err: String(rollback) },
        'voice rename failed and could not be put back; the undo record is kept',
      );
    }
    throw err;
  }
  return {
    action: 'rename',
    undoId: String(doc._id),
    expiresAt: doc.expiresAt.toISOString(),
    meetings: renamed.meetings,
    label,
  };
}

export async function listOpenUndos(workspaceId: string): Promise<OpenUndo[]> {
  const rows = await SpeakerUndoModel.find({
    workspaceId: new Types.ObjectId(workspaceId),
    undoneAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean<SpeakerUndoDoc[]>();
  return rows.map((r) => ({
    id: String(r._id),
    expiresAt: r.expiresAt.toISOString(),
    label: r.label,
    kind: r.kind,
  }));
}

/** Put a merge or rename back. Expired and already-used records are refused. */
export async function undoAssign(workspaceId: string, undoId: string): Promise<void> {
  if (!Types.ObjectId.isValid(undoId)) throw new UndoError(404, 'undo_not_found');
  const undo = await SpeakerUndoModel.findOne({
    _id: undoId,
    workspaceId: new Types.ObjectId(workspaceId),
  }).lean<SpeakerUndoDoc>();
  if (!undo) throw new UndoError(404, 'undo_not_found');
  if (undo.undoneAt) throw new UndoError(409, 'undo_already_used');
  if (undo.expiresAt.getTime() <= Date.now()) throw new UndoError(410, 'undo_expired');
  await assertNothingProcessing();
  // A newer open change to the same people was made on top of this one: put that back first.
  const people = [undo.sourceId, ...(undo.targetId ? [undo.targetId] : [])];
  const newer = await SpeakerUndoModel.exists({
    workspaceId: undo.workspaceId,
    _id: { $ne: undo._id },
    undoneAt: null,
    expiresAt: { $gt: new Date() },
    createdAt: { $gt: undo.createdAt },
    $or: [{ sourceId: { $in: people } }, { targetId: { $in: people } }],
  });
  if (newer) throw new UndoError(409, 'undo_newer_change');

  switch (undo.kind) {
    case 'merge':
      await undoMerge(undo);
      break;
    case 'rename':
      await undoRename(undo);
      break;
    default: {
      const neverKind: never = undo.kind;
      throw new UndoError(409, `Unknown undo (${String(neverKind)})`);
    }
  }
  await SpeakerUndoModel.updateOne({ _id: undo._id }, { $set: { undoneAt: new Date() } });
}

const affectedMeetings = (undo: SpeakerUndoDoc): string[] => [
  ...new Set([
    ...undo.cards.map((c) => String(c.meetingId)),
    ...undo.meetings.map((m) => String(m.meetingId)),
  ]),
];

/**
 * Take back what the merge added. Safe to run on a merge that stopped halfway, and twice: the removed
 * profile is made again only if it is missing, and everything else is written only where it still shows the
 * merge's result.
 */
async function undoMerge(undo: SpeakerUndoDoc): Promise<void> {
  if (!undo.source || !undo.targetId)
    throw new UndoError(409, 'This undo is missing the profile it would restore.');
  const target = await SpeakerModel.findById(undo.targetId).lean();
  if (!target)
    throw new UndoError(
      409,
      'The person this voice was merged into is gone, so this undo cannot be completed.',
    );
  const sourceId = String(undo.sourceId);
  const targetId = String(undo.targetId);
  if (!(await SpeakerModel.exists({ _id: undo.sourceId }))) await SpeakerModel.create(undo.source);
  await SpeakerModel.updateOne(
    { _id: undo.targetId },
    {
      $pull: {
        voiceprints: { id: { $in: undo.addedVoiceprintIds ?? [] } },
        ignoreMeetings: { $in: undo.addedIgnoreMeetings ?? [] },
        ...(undo.addedAlias ? { aliases: undo.addedAlias } : {}),
      },
    },
  );
  // let go of the pin the merge made, unless the voice has been chosen again since
  if (undo.mainPinned)
    await SpeakerModel.updateOne(
      { _id: undo.targetId, mainSampleId: undo.mainPinned },
      { $set: { mainSampleId: undo.mainBefore ?? null } },
    );
  await relinkCards(undo.cards, targetId, sourceId);
  const tasks = undo.taskIds ?? { owner: [], buddy: [], createdBy: [] };
  const toTarget = new Types.ObjectId(targetId);
  if (tasks.owner.length)
    await TaskModel.updateMany(
      { _id: { $in: tasks.owner }, ownerId: toTarget },
      { $set: { ownerId: undo.sourceId } },
    );
  if (tasks.buddy.length)
    await TaskModel.updateMany(
      { _id: { $in: tasks.buddy }, buddyId: toTarget },
      { $set: { buddyId: undo.sourceId } },
    );
  if (tasks.createdBy.length)
    await TaskModel.updateMany(
      { _id: { $in: tasks.createdBy }, createdById: toTarget },
      { $set: { createdById: undo.sourceId } },
    );
  if (undo.meMoved)
    await WorkspaceModel.updateOne(
      { _id: undo.workspaceId, mePersonId: undo.targetId },
      { $set: { mePersonId: undo.sourceId } },
    );
  for (const id of affectedMeetings(undo)) await applyNames(id);
  await restoreSummaries(undo.meetings);
  await restoreMeetingTasks(undo.meetingTasks ?? []);
}

async function undoRename(undo: SpeakerUndoDoc): Promise<void> {
  if (!undo.previousName)
    throw new UndoError(409, 'This undo is missing the name it would restore.');
  const person = await SpeakerModel.findById(undo.sourceId).lean();
  if (!person) throw new UndoError(409, 'That voice was deleted, so this undo cannot be completed.');
  // the name was changed again since: the later name is kept
  if (undo.newName && person.name !== undo.newName)
    throw new UndoError(409, 'That name was changed again since, so this undo cannot be applied.');
  try {
    await SpeakerModel.updateOne(
      { _id: undo.sourceId },
      { $set: { name: undo.previousName, anonymous: undo.previousAnonymous ?? false } },
    );
  } catch (err) {
    // the old name was taken by someone else in the meantime (names are unique)
    if ((err as { code?: number }).code === 11000)
      throw new UndoError(409, 'Someone else now has the old name, so this undo cannot be applied.');
    throw err;
  }
  for (const m of undo.meetings) await applyNames(String(m.meetingId));
  await restoreSummaries(undo.meetings);
  await restoreMeetingTasks(undo.meetingTasks ?? []);
}

/**
 * Mark a named person as having left. Past meetings keep the name. The profile stays, so this is
 * not a delete. Placeholder voices are not "people who left".
 */
export async function markPersonLeft(workspaceId: string, personId: string): Promise<Date> {
  const person = await personIn(workspaceId, personId);
  if (person.anonymous)
    throw new EditError(
      'A placeholder voice is not someone who has left. Assign it to a person, or delete it.',
    );
  if (person.leftAt) return new Date(person.leftAt);
  const leftAt = new Date();
  await SpeakerModel.updateOne({ _id: person._id }, { $set: { leftAt } });
  return leftAt;
}

/** The person is back: their voice is matched in new meetings again. */
export async function markPersonBack(workspaceId: string, personId: string): Promise<void> {
  const person = await personIn(workspaceId, personId);
  if (!person.leftAt) return;
  await SpeakerModel.updateOne({ _id: person._id }, { $set: { leftAt: null } });
}
