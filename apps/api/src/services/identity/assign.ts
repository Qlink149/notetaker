import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import {
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
 * Undo window: `SPEAKER_UNDO_MINUTES` (default 10). Undo writes the profiles, the meeting links
 * and the summary text back to the snapshot taken just before the change. It does not regenerate
 * a summary. A summary someone regenerates by hand during the window is put back too. After the
 * window the record stays so a late click can say the undo has expired.
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

function profileBefore(p: SpeakerDoc): NonNullable<SpeakerUndoDoc['targetBefore']> {
  return {
    name: p.name,
    anonymous: p.anonymous ?? false,
    aliases: [...(p.aliases ?? [])],
    voiceprints: (p.voiceprints ?? []).map((v) => ({ ...v })),
    email: p.email ?? null,
    role: p.role ?? null,
    leftAt: p.leftAt ?? null,
  };
}

function copySpeaker(p: SpeakerDoc): SpeakerDoc {
  const copy: SpeakerDoc = {
    _id: p._id,
    workspaceId: p.workspaceId,
    name: p.name,
    aliases: [...(p.aliases ?? [])],
    anonymous: p.anonymous ?? false,
    origin: p.origin ?? null,
    voiceprints: (p.voiceprints ?? []).map((v) => ({ ...v })),
    email: p.email ?? null,
    role: p.role ?? null,
    leftAt: p.leftAt ?? null,
    createdAt: p.createdAt,
  };
  return copy;
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

async function restoreSummaries(snaps: SpeakerUndoMeetingSnap[]): Promise<void> {
  for (const s of snaps) {
    await MeetingModel.updateOne(
      { _id: s.meetingId },
      {
        $set: {
          summary: s.summary,
          actionItems: s.actionItems,
          summaryNames: s.summaryNames,
          summaryOutdated: s.summaryOutdated,
          summaryAt: s.summaryAt,
        },
      },
    );
  }
}

async function relinkCards(
  cards: { meetingId: Types.ObjectId; diar: string }[],
  personId: string,
): Promise<void> {
  for (const card of cards) {
    await MeetingDataModel.updateOne(
      { meetingId: card.meetingId },
      {
        $set: {
          'speakerCards.$[c].personId': personId,
          'speakerCards.$[c].voiceDeleted': false,
        },
      },
      { arrayFilters: [{ 'c.diar': card.diar }] },
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
    const undo = await commitMerge(workspaceId, source, target, meetings);
    return { needsConfirmation: false, ...undo, undoMinutes: minutes };
  }

  const name = cleanPersonName(input.name ?? '');
  if (!name) throw new EditError('Enter a name.');
  if (name.length > 100) throw new EditError('That name is too long.');
  if (samePersonName(source.name, name) && source.anonymous !== true) {
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
  const [cards, tasks, snaps, meMoved] = await Promise.all([
    cardsOf(sourceId),
    taskIdsOf(sourceId),
    meetingSnaps(meetings),
    WorkspaceModel.exists({
      _id: new Types.ObjectId(workspaceId),
      mePersonId: source._id,
    }),
  ]);
  const affected = await mergePeople(String(target._id), sourceId);
  const label = `Merged “${source.name}” into ${target.name}`;
  const doc = await SpeakerUndoModel.create({
    workspaceId: new Types.ObjectId(workspaceId),
    kind: 'merge',
    expiresAt: new Date(Date.now() + undoWindowMs()),
    undoneAt: null,
    sourceId: source._id,
    source: copySpeaker(source),
    targetId: target._id,
    targetBefore: profileBefore(target),
    previousName: null,
    previousAnonymous: null,
    cards,
    taskIds: tasks,
    meMoved: Boolean(meMoved),
    meetings: snaps,
    label,
  });
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
  const snaps = await meetingSnaps(meetings);
  const renamed = await renamePerson(String(source._id), name);
  const label = `Named “${source.name}” as ${name}`;
  const doc = await SpeakerUndoModel.create({
    workspaceId: new Types.ObjectId(workspaceId),
    kind: 'rename',
    expiresAt: new Date(Date.now() + undoWindowMs()),
    undoneAt: null,
    sourceId: source._id,
    source: null,
    targetId: null,
    targetBefore: null,
    previousName: source.name,
    previousAnonymous: source.anonymous ?? false,
    cards: [],
    taskIds: { owner: [], buddy: [], createdBy: [] },
    meMoved: false,
    meetings: snaps,
    label,
  });
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

async function undoMerge(undo: SpeakerUndoDoc): Promise<void> {
  if (!undo.source || !undo.targetId || !undo.targetBefore)
    throw new UndoError(409, 'This undo is missing the profiles it would restore.');
  const target = await SpeakerModel.findById(undo.targetId).lean();
  if (!target)
    throw new UndoError(
      409,
      'The person this voice was merged into is gone, so this undo cannot be completed.',
    );
  await SpeakerModel.create(undo.source);
  const before = undo.targetBefore;
  await SpeakerModel.updateOne(
    { _id: undo.targetId },
    {
      $set: {
        name: before.name,
        anonymous: before.anonymous,
        aliases: before.aliases,
        voiceprints: before.voiceprints,
        email: before.email,
        role: before.role,
        leftAt: before.leftAt,
      },
    },
  );
  await relinkCards(undo.cards, String(undo.sourceId));
  const tasks = undo.taskIds ?? { owner: [], buddy: [], createdBy: [] };
  if (tasks.owner.length)
    await TaskModel.updateMany({ _id: { $in: tasks.owner } }, { $set: { ownerId: undo.sourceId } });
  if (tasks.buddy.length)
    await TaskModel.updateMany({ _id: { $in: tasks.buddy } }, { $set: { buddyId: undo.sourceId } });
  if (tasks.createdBy.length)
    await TaskModel.updateMany(
      { _id: { $in: tasks.createdBy } },
      { $set: { createdById: undo.sourceId } },
    );
  if (undo.meMoved)
    await WorkspaceModel.updateOne(
      { _id: undo.workspaceId },
      { $set: { mePersonId: undo.sourceId } },
    );
  const meetingIds = [
    ...new Set([
      ...undo.cards.map((c) => String(c.meetingId)),
      ...undo.meetings.map((m) => String(m.meetingId)),
    ]),
  ];
  for (const id of meetingIds) await applyNames(id);
  await restoreSummaries(undo.meetings);
}

async function undoRename(undo: SpeakerUndoDoc): Promise<void> {
  if (!undo.previousName)
    throw new UndoError(409, 'This undo is missing the name it would restore.');
  const person = await SpeakerModel.findById(undo.sourceId).lean();
  if (!person) throw new UndoError(409, 'That voice was deleted, so this undo cannot be completed.');
  await SpeakerModel.updateOne(
    { _id: undo.sourceId },
    { $set: { name: undo.previousName, anonymous: undo.previousAnonymous ?? false } },
  );
  for (const m of undo.meetings) await applyNames(String(m.meetingId));
  await restoreSummaries(undo.meetings);
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
