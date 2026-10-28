import { Types } from 'mongoose';
import type { Line, Turn } from '@meetingid/shared';
import { foldName, overlappingNames, similarNames } from '@meetingid/pipeline';
import {
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  TaskModel,
  WorkspaceModel,
  type SpeakerCardDoc,
  type SpeakerDoc,
} from '../../models/index.js';
import {
  applyNames,
  meetingsOfPerson,
  peopleOf,
  renamePerson,
  type ApplyResult,
} from './identity.js';
import { enqueue } from '../../pipeline/queue.js';

// Review-screen edits: merge, split, reassign, name. Every edit rewrites this meeting's turns and
// cards, then calls applyNames so its lines re-merge. Naming or linking a speaker stays in this
// meeting. Rewriting every meeting of a person, or folding one person into another, happens only
// when the caller asks to rename everywhere or merges the two identities.

export class EditError extends Error {}

/** The typed name matches people who already exist. The route answers 409 so the UI can ask. */
export class SimilarPersonError extends Error {
  readonly similar: { id: string; name: string }[];
  constructor(similar: { id: string; name: string }[]) {
    super('similar_name');
    this.name = 'SimilarPersonError';
    this.similar = similar;
  }
}

const letters = (i: number): string =>
  i < 26
    ? String.fromCharCode(65 + i)
    : letters(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26));

/** Next "Speaker X" label not used by any card of the meeting. */
export function nextLabel(cards: SpeakerCardDoc[]): string {
  const used = new Set(cards.map((c) => c.label));
  for (let i = 0; ; i++) if (!used.has(`Speaker ${letters(i)}`)) return `Speaker ${letters(i)}`;
}

/** Next synthetic diar id for a voice split off `base` ("S0" → "S0~1"). Never reuses a suffix. */
function nextSplitDiar(cards: SpeakerCardDoc[], base: string): string {
  const root = base.replace(/~\d+$/, '');
  const used = cards
    .map((c) => (c.diar.startsWith(`${root}~`) ? Number(c.diar.slice(root.length + 1)) : 0))
    .filter((n) => Number.isFinite(n));
  return `${root}~${Math.max(0, ...used) + 1}`;
}

async function load(meetingId: string) {
  const data = await MeetingDataModel.findOne({ meetingId }).lean();
  if (!data || data.speakerSource !== 'pyannote')
    throw new EditError('This meeting has no pyannote speakers to edit.');
  return {
    turns: (data.turns as Turn[]).map((t) => ({ ...t })),
    cards: (data.speakerCards ?? []) as SpeakerCardDoc[],
    lines: data.lines as Line[],
    speakerMap: data.speakerMap as Record<string, string>,
  };
}

/** Turns that make up one transcript line (overlap-based, so lines split from long turns still resolve). */
function turnsOfLine(turns: Turn[], line: Line, speakerMap: Record<string, string>): Turn[] {
  return turns.filter((t) => {
    if (speakerMap[t.speaker] !== line.speakerName) return false;
    const overlap = Math.min(t.end, line.end) - Math.max(t.start, line.start);
    return (
      overlap > 0 &&
      overlap >= 0.5 * Math.max(0.01, Math.min(t.end - t.start, line.end - line.start))
    );
  });
}

async function save(
  meetingId: string,
  turns: Turn[],
  cards: SpeakerCardDoc[],
  merged?: { from: string; into: string },
): Promise<ApplyResult | null> {
  await MeetingDataModel.updateOne(
    { meetingId },
    {
      $set: { turns, speakerCards: cards },
      // Kept with the automatic merges: every later read of the pyannote speakers (a retry rebuilding the
      // transcript, re-identification) applies it, so the merge is not undone.
      ...(merged
        ? {
            $push: {
              speakerMerges: { ...merged, ambiguity: [0, 0], overlapShare: 0, manual: true },
            },
          }
        : {}),
    },
  );
  return applyNames(meetingId);
}

/** Merge two people into one: voiceprints, aliases and every meeting card move to the survivor. */
export async function mergePeople(keepId: string, dropId: string): Promise<string[]> {
  if (keepId === dropId) return [];
  const [keep, drop] = await Promise.all([
    SpeakerModel.findById(keepId).lean<SpeakerDoc>(),
    SpeakerModel.findById(dropId).lean<SpeakerDoc>(),
  ]);
  if (!keep || !drop) throw new EditError('Person not found.');
  if (String(keep.workspaceId) !== String(drop.workspaceId))
    throw new EditError('Those people belong to different workspaces.');
  await SpeakerModel.updateOne(
    { _id: keepId },
    {
      $push: { voiceprints: { $each: drop.voiceprints } },
      $addToSet: {
        ignoreMeetings: { $each: drop.ignoreMeetings ?? [] },
        ...(drop.anonymous ? {} : { aliases: drop.name }),
      },
    },
  );
  const affected = await meetingsOfPerson(dropId);
  await MeetingDataModel.updateMany(
    { 'speakerCards.personId': dropId },
    { $set: { 'speakerCards.$[c].personId': keepId } },
    { arrayFilters: [{ 'c.personId': dropId }] },
  );
  // Tasks point at the person, so an explicit merge keeps them with the surviving profile.
  const dropOid = new Types.ObjectId(dropId);
  const keepOid = new Types.ObjectId(keepId);
  await TaskModel.updateMany({ ownerId: dropOid }, { $set: { ownerId: keepOid } });
  await TaskModel.updateMany({ buddyId: dropOid }, { $set: { buddyId: keepOid } });
  await TaskModel.updateMany({ createdById: dropOid }, { $set: { createdById: keepOid } });
  await WorkspaceModel.updateMany({ mePersonId: dropOid }, { $set: { mePersonId: keepOid } });
  await SpeakerModel.deleteOne({ _id: dropId });
  for (const m of affected) await applyNames(m);
  return affected;
}

/**
 * Make `intoDiar` absorb `fromDiar` in this meeting. When the two voices are different people, this is
 * the explicit identity merge: the surviving person keeps both histories and both people's tasks.
 */
export async function mergeSpeakers(
  meetingId: string,
  fromDiar: string,
  intoDiar: string,
): Promise<ApplyResult | null> {
  const { turns, cards } = await load(meetingId);
  const from = cards.find((c) => c.diar === fromDiar);
  const into = cards.find((c) => c.diar === intoDiar);
  if (!from || !into || from === into)
    throw new EditError('Pick two different speakers of this meeting.');
  for (const t of turns) if (t.speaker === fromDiar) t.speaker = intoDiar;
  into.speakerSec = Math.round((into.speakerSec + from.speakerSec) * 10) / 10;
  into.status = 'manual';
  const rest = cards.filter((c) => c !== from);
  if (from.personId && into.personId && from.personId !== into.personId) {
    // keep a named person over an anonymous one
    const people = await peopleOf([from.personId, into.personId]);
    const keepFrom =
      people.get(from.personId)?.anonymous === false &&
      people.get(into.personId)?.anonymous !== false;
    const [keep, drop] = keepFrom ? [from.personId, into.personId] : [into.personId, from.personId];
    into.personId = keep;
    await save(meetingId, turns, rest, { from: fromDiar, into: intoDiar });
    await mergePeople(keep, drop);
    return applyNames(meetingId);
  }
  if (!into.personId) into.personId = from.personId;
  return save(meetingId, turns, rest, { from: fromDiar, into: intoDiar });
}

/**
 * Make this voice the same person as a saved profile. A person not already in the meeting is an
 * identity merge when this voice already has its own profile (other meetings and tasks move with it).
 * A voice with no profile is linked, and other meetings stay where they are. A person who already
 * has a voice here is folded in with `mergeSpeakers`.
 */
export async function mergeSpeakerIntoPerson(
  meetingId: string,
  workspaceId: string,
  fromDiar: string,
  intoPersonId: string,
): Promise<ApplyResult | null> {
  if (!Types.ObjectId.isValid(intoPersonId)) throw new EditError('Unknown person.');
  const target = await SpeakerModel.findOne({ _id: intoPersonId, workspaceId }).lean();
  if (!target) throw new EditError('Unknown person.');
  const { turns, cards } = await load(meetingId);
  const from = cards.find((c) => c.diar === fromDiar);
  if (!from) throw new EditError('Speaker not found.');
  if (from.personId === intoPersonId) throw new EditError('That voice is already this person.');
  const intoCard = cards.find((c) => c.personId === intoPersonId && c.diar !== fromDiar);
  if (intoCard) return mergeSpeakers(meetingId, fromDiar, intoCard.diar);
  if (from.personId) {
    await mergePeople(intoPersonId, from.personId);
    return applyNames(meetingId);
  }
  from.personId = intoPersonId;
  from.status = 'manual';
  from.confirmed = true;
  from.match = null;
  return save(meetingId, turns, cards);
}

/** From the chosen line onward, move that speaker's turns to a new speaker (a person wrongly merged). */
export async function splitSpeaker(
  meetingId: string,
  lineIndex: number,
): Promise<{ result: ApplyResult | null; label: string }> {
  const { turns, cards, lines, speakerMap } = await load(meetingId);
  const line = lines[lineIndex];
  if (!line) throw new EditError('That line does not exist.');
  const first = turnsOfLine(turns, line, speakerMap).sort((a, b) => a.start - b.start)[0];
  if (!first) throw new EditError('Could not find the speech of that line.');
  const diar = first.speaker;
  const card = cards.find((c) => c.diar === diar);
  if (!card) throw new EditError('Speaker not found.');
  const id = nextSplitDiar(cards, diar);
  const label = nextLabel(cards);
  let moved = 0;
  for (const t of turns) {
    if (t.speaker === diar && t.start >= first.start - 0.001) {
      t.speaker = id;
      moved += t.end - t.start;
    }
  }
  card.speakerSec = Math.max(0, Math.round((card.speakerSec - moved) * 10) / 10);
  card.status = 'manual';
  cards.push({
    diar: id,
    label,
    personId: null,
    speakerSec: Math.round(moved * 10) / 10,
    match: null,
    candidate: null,
    status: 'manual',
    clips: [],
  });
  return { result: await save(meetingId, turns, cards), label };
}

export interface ReassignTarget {
  /** Another voice already detected in this meeting. */
  toDiar?: string;
  /** A saved person, including one this meeting has not detected. */
  toPersonId?: string;
  /** A name to create, or to link when it is already a saved person. */
  toName?: string;
  /** Keep `toName` as a new person even when it looks like someone saved. */
  createNew?: boolean;
}

type Clip = SpeakerCardDoc['clips'][number];

/** A sample belongs with the speech that was moved when most of the sample sits inside it. */
function clipFollows(clip: Clip, intervals: { start: number; end: number }[]): boolean {
  const dur = clip.end - clip.start;
  if (!(dur > 0)) return false;
  let covered = 0;
  for (const iv of intervals) {
    const overlap = Math.min(clip.end, iv.end) - Math.max(clip.start, iv.start);
    if (overlap > 0) covered += overlap;
  }
  return covered >= dur * 0.5;
}

/**
 * Named people the typed name probably already is: the same name, a typo, or the same name with an
 * extra word ("Parag Bhai" / "Parag"). `exceptPersonId` is the profile being renamed, so extending
 * that person's own name is not a clash.
 */
export async function peopleSimilarTo(
  workspaceId: string,
  name: string,
  exceptPersonId?: string | null,
): Promise<{ id: string; name: string }[]> {
  const named = await SpeakerModel.find({
    workspaceId: new Types.ObjectId(workspaceId),
    anonymous: false,
    ...(exceptPersonId && Types.ObjectId.isValid(exceptPersonId)
      ? { _id: { $ne: new Types.ObjectId(exceptPersonId) } }
      : {}),
  }).lean<SpeakerDoc[]>();
  const names = named.map((p) => p.name);
  const hit = new Set([...similarNames(name, names), ...overlappingNames(name, names)]);
  return named.filter((p) => hit.has(p.name)).map((p) => ({ id: String(p._id), name: p.name }));
}

async function personInWorkspace(workspaceId: string, personId: string): Promise<SpeakerDoc> {
  if (!Types.ObjectId.isValid(personId)) throw new EditError('Unknown person.');
  const person = await SpeakerModel.findOne({
    _id: personId,
    workspaceId: new Types.ObjectId(workspaceId),
  }).lean<SpeakerDoc>();
  if (!person) throw new EditError('Unknown person.');
  return person;
}

/**
 * The card that should receive the line. A saved person who already speaks in this meeting reuses
 * their card. Someone who does not gets a new card in this meeting only — the group the line left
 * keeps its name, and no other meeting is rewritten.
 */
async function cardForTarget(
  workspaceId: string,
  meetingId: string,
  cards: SpeakerCardDoc[],
  sampleDiar: string,
  target: ReassignTarget,
): Promise<SpeakerCardDoc> {
  if (target.toDiar) {
    const card = cards.find((c) => c.diar === target.toDiar);
    if (!card) throw new EditError('Line or speaker not found.');
    return card;
  }

  let personId = target.toPersonId ?? null;
  const typed = target.toName?.trim().replace(/\s+/g, ' ') ?? '';
  if (!personId && typed) {
    if (!target.createNew) {
      const similar = await peopleSimilarTo(workspaceId, typed);
      const exact = similar.filter((s) => foldName(s.name) === foldName(typed));
      if (exact.length === 1 && similar.length === exact.length) personId = exact[0]!.id;
      else if (similar.length) throw new SimilarPersonError(similar);
    }
    if (!personId) {
      const clash = await SpeakerModel.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        name: typed,
      }).lean<SpeakerDoc>();
      if (clash && target.createNew)
        throw new EditError(
          'A person with that name already exists. Link this recording to them, or type a different name.',
        );
      personId = clash
        ? String(clash._id)
        : await createNamedPerson(workspaceId, meetingId, sampleDiar, typed);
    }
  }
  if (!personId) throw new EditError('Choose a speaker, a saved person, or a new name.');

  await personInWorkspace(workspaceId, personId);
  const existing = cards.find((c) => c.personId === personId);
  if (existing) return existing;
  const created: SpeakerCardDoc = {
    diar: nextSplitDiar(cards, sampleDiar),
    label: nextLabel(cards),
    personId,
    speakerSec: 0,
    match: null,
    candidate: null,
    status: 'manual',
    clips: [],
  };
  cards.push(created);
  return created;
}

/**
 * Give one transcript line to another speaker. That can be a voice in this meeting, any saved
 * person, or a new name. Only this line's speech moves; the rest of the group, and every other
 * meeting, stay with the person they already belong to.
 */
export async function reassignLine(
  meetingId: string,
  workspaceId: string,
  lineIndex: number,
  target: ReassignTarget,
): Promise<ApplyResult | null> {
  const { turns, cards, lines, speakerMap } = await load(meetingId);
  const line = lines[lineIndex];
  if (!line) throw new EditError('Line or speaker not found.');
  const mine = turnsOfLine(turns, line, speakerMap);
  if (!mine.length) throw new EditError('Could not find the speech of that line.');
  const dest = await cardForTarget(workspaceId, meetingId, cards, mine[0]!.speaker, target);

  const movedFrom = new Map<string, { start: number; end: number }[]>();
  for (const t of mine) {
    if (t.speaker === dest.diar) continue;
    const from = cards.find((c) => c.diar === t.speaker);
    const sec = t.end - t.start;
    if (from) from.speakerSec = Math.max(0, Math.round((from.speakerSec - sec) * 10) / 10);
    dest.speakerSec = Math.round((dest.speakerSec + sec) * 10) / 10;
    const intervals = movedFrom.get(t.speaker) ?? [];
    intervals.push({ start: t.start, end: t.end });
    movedFrom.set(t.speaker, intervals);
    t.speaker = dest.diar;
  }
  if (movedFrom.size === 0) return applyNames(meetingId);

  for (const [diar, intervals] of movedFrom) {
    const from = cards.find((c) => c.diar === diar);
    if (!from) continue;
    const go = (from.clips ?? []).filter((clip) => clipFollows(clip, intervals));
    if (!go.length) continue;
    const going = new Set(go);
    from.clips = (from.clips ?? []).filter((clip) => !going.has(clip));
    const have = new Set((dest.clips ?? []).map((clip) => Math.round(clip.start)));
    const fresh = go.filter((clip) => !have.has(Math.round(clip.start)));
    dest.clips = [...(dest.clips ?? []), ...fresh].sort((a, b) => a.start - b.start);
    if (from.personId && from.personId !== dest.personId)
      await forgetVoice(from.personId, meetingId, go);
  }
  return save(meetingId, turns, cards);
}

const sameName = (a: string, b: string): boolean =>
  a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

/** Remove the voiceprints a person got from these clips (speech that turned out to be someone else). */
async function forgetVoice(
  personId: string,
  meetingId: string,
  clips: { start: number }[],
): Promise<void> {
  const starts = new Set(clips.map((c) => Math.round(c.start)));
  if (!starts.size) return;
  const person = await SpeakerModel.findById(personId).lean<SpeakerDoc>();
  if (!person) return;
  const keep = person.voiceprints.filter(
    (v) => !(String(v.meetingId) === meetingId && v.clip && starts.has(Math.round(v.clip.start))),
  );
  if (keep.length !== person.voiceprints.length)
    await SpeakerModel.updateOne({ _id: personId }, { $set: { voiceprints: keep } });
}

const duplicateName = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  'code' in err &&
  (err as { code: unknown }).code === 11000;

async function personHeardElsewhere(personId: string, meetingId: string): Promise<boolean> {
  const meetings = await meetingsOfPerson(personId);
  return meetings.some((m) => m !== meetingId);
}

/**
 * A placeholder that this meeting was the last to use can be removed. Its voiceprints move to
 * `intoId` when the caller just linked this recording to that person. A placeholder that still has
 * another meeting, a task, or the workspace "me" is left alone — those belong to that identity.
 */
async function absorbLonePlaceholder(personId: string, intoId: string | null): Promise<void> {
  const person = await SpeakerModel.findById(personId).lean<SpeakerDoc>();
  if (!person?.anonymous) return;
  if ((await meetingsOfPerson(personId)).length) return;
  const id = new Types.ObjectId(personId);
  if (await TaskModel.exists({ $or: [{ ownerId: id }, { buddyId: id }, { createdById: id }] }))
    return;
  if (await WorkspaceModel.exists({ mePersonId: id })) return;
  if (intoId && person.voiceprints.length)
    await SpeakerModel.updateOne(
      { _id: intoId },
      { $push: { voiceprints: { $each: person.voiceprints } } },
    );
  await SpeakerModel.deleteOne({ _id: id });
}

async function createNamedPerson(
  workspaceId: string,
  meetingId: string,
  diar: string,
  name: string,
): Promise<string> {
  try {
    const created = await SpeakerModel.create({
      workspaceId: new Types.ObjectId(workspaceId),
      name,
      anonymous: false,
      origin: { meetingId: new Types.ObjectId(meetingId), diar },
    });
    return String(created._id);
  } catch (err) {
    if (duplicateName(err))
      throw new EditError(
        'A person with that name already exists. Link this recording to them, or type a different name.',
      );
    throw err;
  }
}

/** Learn the meeting's confirmed voices in the worker (cutting clips needs the meeting audio). */
async function learnLater(meetingId: string): Promise<void> {
  await enqueue({ meetingId, stage: 'learnvoice' });
}

/**
 * Name a voice in this meeting.
 *
 * Linking (`usePersonId`) or typing a different name points this recording at that profile and leaves
 * every other meeting on the previous one. A person who appears only in this meeting is renamed in
 * place, so tasks that point at them follow the new name. `renameEverywhere` renames a shared profile
 * in every meeting. Combining two profiles is `mergePeople`, reached from
 * an explicit speaker merge, not from a correction. The confirmed voice is learned afterwards.
 * Returns the meetings whose lines changed.
 */
export async function nameSpeaker(
  meetingId: string,
  workspaceId: string,
  diar: string,
  name: string,
  usePersonId?: string,
  { renameEverywhere = false }: { renameEverywhere?: boolean } = {},
): Promise<{ personId: string; changed: string[]; meetings: string[] }> {
  const loaded = await load(meetingId);
  const cards = loaded.cards;
  const card = cards.find((c) => c.diar === diar);
  if (!card) throw new EditError('Speaker not found.');
  let personId = card.personId;
  // a card may point at a person who was deleted since (Speakers page): treat it as having none
  if (personId && !(await SpeakerModel.exists({ _id: personId, workspaceId }))) {
    personId = null;
    card.personId = null;
  }
  const current = personId ? await SpeakerModel.findById(personId).lean<SpeakerDoc>() : null;
  const heardElsewhere = personId ? await personHeardElsewhere(personId, meetingId) : false;

  const finishHere = async (
    id: string,
  ): Promise<{ personId: string; changed: string[]; meetings: string[] }> => {
    const r = await applyNames(meetingId);
    await learnLater(meetingId);
    return { personId: id, changed: r?.namesChanged ? [meetingId] : [], meetings: [meetingId] };
  };

  if (usePersonId) {
    if (!Types.ObjectId.isValid(usePersonId)) throw new EditError('Unknown person.');
    const target = await SpeakerModel.findOne({ _id: usePersonId, workspaceId }).lean();
    if (!target) throw new EditError('Unknown person.');
    // This recording joins the chosen person. The previous profile is not merged into them: another
    // meeting's tasks and history stay where they are. Clips this card taught a shared profile are
    // taken back; a placeholder that existed only here is folded in, because it has no other history.
    if (card.match && card.match.personId !== usePersonId) card.match = null;
    card.personId = usePersonId;
    card.status = 'solid';
    card.confirmed = true;
    await MeetingDataModel.updateOne({ meetingId }, { $set: { speakerCards: cards } });
    // Take this recording's clips off a profile that other meetings still use. A placeholder that
    // existed only here is absorbed below, clips included, because it has no other history.
    if (personId && personId !== usePersonId && heardElsewhere)
      await forgetVoice(personId, meetingId, card.clips ?? []);
    if (personId && personId !== usePersonId) await absorbLonePlaceholder(personId, usePersonId);
    return finishHere(usePersonId);
  }

  // A person who is only in this meeting has no other history, so a new name is the same profile and
  // the tasks that point at it follow. Someone heard in another meeting stays there unless asked.
  const rewriteProfile = renameEverywhere || !current || !heardElsewhere;

  if (!rewriteProfile && current && !sameName(current.name, name)) {
    const createdId = await createNamedPerson(workspaceId, meetingId, diar, name);
    card.personId = createdId;
    card.match = null;
    card.status = 'solid';
    card.confirmed = true;
    await MeetingDataModel.updateOne({ meetingId }, { $set: { speakerCards: cards } });
    if (personId && heardElsewhere) await forgetVoice(personId, meetingId, card.clips ?? []);
    if (personId) await absorbLonePlaceholder(personId, createdId);
    return finishHere(createdId);
  }

  if (!rewriteProfile && current && sameName(current.name, name)) {
    card.status = 'solid';
    card.confirmed = true;
    await MeetingDataModel.updateOne({ meetingId }, { $set: { speakerCards: cards } });
    return finishHere(personId!);
  }

  if (!personId) {
    personId = await createNamedPerson(workspaceId, meetingId, diar, name);
    card.personId = personId;
  }
  card.status = 'solid';
  card.confirmed = true;
  await MeetingDataModel.updateOne({ meetingId }, { $set: { speakerCards: cards } });
  let renamed: { meetings: string[]; changed: string[] };
  try {
    renamed = await renamePerson(personId, name);
  } catch (err) {
    if (duplicateName(err))
      throw new EditError(
        'A person with that name already exists. Link this recording to them, or type a different name.',
      );
    throw err;
  }
  await learnLater(meetingId);
  return { personId, changed: renamed.changed, meetings: renamed.meetings };
}

export interface IdentityRestore {
  /** Profile the meetings are taken off (the one a correction wrongly rewrote or absorbed). */
  fromPersonId: string;
  /** Meetings that should leave that profile. Anything not listed stays. */
  meetingIds: string[];
  /** Name of the identity those meetings go back to. Must not already exist. */
  name: string;
  /** Move tasks from these meetings that are owned by `fromPersonId` back as well. */
  moveTasks?: boolean;
  /**
   * Tasks in these meetings whose owner was deleted (an older merge did not keep them) are given to
   * the restored person.
   */
  adoptOrphanTasks?: boolean;
}

export interface IdentityRestorePlan {
  applied: boolean;
  personId: string | null;
  name: string;
  meetings: string[];
  voiceprints: number;
  tasks: number;
  orphanTasks: number;
}

/**
 * Give listed meetings back to a separate person. Used to repair a correction that renamed a shared
 * profile, or merged it into someone else, before this was limited to one recording. Does nothing
 * to the database unless `apply` is set — callers (the repair script) default to a dry run.
 */
export async function restoreIdentity(
  workspaceId: string,
  input: IdentityRestore,
  { apply }: { apply: boolean },
): Promise<IdentityRestorePlan> {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!name) throw new EditError('The restored person needs a name.');
  if (!Types.ObjectId.isValid(input.fromPersonId)) throw new EditError('Person not found.');
  const from = await SpeakerModel.findOne({
    _id: input.fromPersonId,
    workspaceId,
  }).lean<SpeakerDoc>();
  if (!from) throw new EditError('Person not found.');
  if (await SpeakerModel.exists({ workspaceId, name }))
    throw new EditError(
      `A person named "${name}" already exists. Restore under the name this identity had, or another free name.`,
    );

  const meetingIds = [...new Set(input.meetingIds.map((id) => id.trim()).filter(Boolean))];
  if (!meetingIds.length) throw new EditError('Name the meetings to give back.');
  let objectIds: Types.ObjectId[];
  try {
    objectIds = meetingIds.map((id) => new Types.ObjectId(id));
  } catch {
    throw new EditError('One of those meetings is not an id.');
  }
  const owned = await MeetingModel.find(
    { _id: { $in: objectIds }, workspaceId },
    { _id: 1 },
  ).lean();
  const allowed = new Set(owned.map((m) => String(m._id)));
  const docs = await MeetingDataModel.find(
    { meetingId: { $in: [...allowed].map((id) => new Types.ObjectId(id)) } },
    { meetingId: 1, speakerCards: 1 },
  ).lean();
  const hit = docs.filter((d) =>
    ((d.speakerCards ?? []) as SpeakerCardDoc[]).some((c) => c.personId === input.fromPersonId),
  );
  if (!hit.length) throw new EditError('None of those meetings are linked to that person.');
  const moving = new Set(hit.map((d) => String(d.meetingId)));
  const voiceprints = from.voiceprints.filter(
    (v) => v.meetingId && moving.has(String(v.meetingId)),
  ).length;

  const fromOid = new Types.ObjectId(input.fromPersonId);
  const meetingOids = [...moving].map((id) => new Types.ObjectId(id));
  const taskFilter = {
    workspaceId: new Types.ObjectId(workspaceId),
    meetingId: { $in: meetingOids },
    $or: [{ ownerId: fromOid }, { buddyId: fromOid }, { createdById: fromOid }],
  };
  const tasks = input.moveTasks ? await TaskModel.countDocuments(taskFilter) : 0;
  let orphanTasks = 0;
  let orphanIds: Types.ObjectId[] = [];
  if (input.adoptOrphanTasks) {
    const inMeetings = await TaskModel.find(
      {
        workspaceId: new Types.ObjectId(workspaceId),
        meetingId: { $in: meetingOids },
        ownerId: { $ne: null },
      },
      { _id: 1, ownerId: 1 },
    ).lean();
    const people = new Set(
      (
        await SpeakerModel.find({ workspaceId: new Types.ObjectId(workspaceId) }, { _id: 1 }).lean()
      ).map((p) => String(p._id)),
    );
    orphanIds = inMeetings
      .filter((t) => t.ownerId && !people.has(String(t.ownerId)))
      .map((t) => t._id);
    orphanTasks = orphanIds.length;
  }

  const plan: IdentityRestorePlan = {
    applied: false,
    personId: null,
    name,
    meetings: [...moving],
    voiceprints,
    tasks,
    orphanTasks,
  };
  if (!apply) return plan;

  const created = await SpeakerModel.create({
    workspaceId: new Types.ObjectId(workspaceId),
    name,
    anonymous: false,
    origin: from.origin,
  });
  const restoredId = String(created._id);
  for (const doc of hit) {
    const cards = ((doc.speakerCards ?? []) as SpeakerCardDoc[]).map((c) =>
      c.personId === input.fromPersonId
        ? {
            ...c,
            personId: restoredId,
            match: c.match?.personId === input.fromPersonId ? null : c.match,
            status: 'manual' as const,
            confirmed: true,
          }
        : c,
    );
    await MeetingDataModel.updateOne({ _id: doc._id }, { $set: { speakerCards: cards } });
  }
  if (voiceprints) {
    const moved = from.voiceprints.filter((v) => v.meetingId && moving.has(String(v.meetingId)));
    const stay = from.voiceprints.filter((v) => !moved.includes(v));
    await SpeakerModel.updateOne({ _id: from._id }, { $set: { voiceprints: stay } });
    await SpeakerModel.updateOne({ _id: created._id }, { $set: { voiceprints: moved } });
  }
  if (input.moveTasks) {
    const restoredOid = created._id;
    await TaskModel.updateMany(
      { ...taskFilter, ownerId: fromOid },
      { $set: { ownerId: restoredOid } },
    );
    await TaskModel.updateMany(
      { ...taskFilter, buddyId: fromOid },
      { $set: { buddyId: restoredOid } },
    );
    await TaskModel.updateMany(
      { ...taskFilter, createdById: fromOid },
      { $set: { createdById: restoredOid } },
    );
  }
  if (orphanIds.length)
    await TaskModel.updateMany({ _id: { $in: orphanIds } }, { $set: { ownerId: created._id } });
  for (const id of moving) await applyNames(id);
  return { ...plan, applied: true, personId: restoredId };
}
