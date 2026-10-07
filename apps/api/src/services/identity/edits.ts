import { Types } from 'mongoose';
import type { Line, Turn } from '@meetingid/shared';
import {
  MeetingDataModel,
  SpeakerModel,
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

// Review-screen edits: merge, split, reassign, name. Every edit rewrites the turns' speakers and the
// cards, then calls applyNames so lines re-merge and every meeting that shows the person updates.

export class EditError extends Error {}

const letters = (i: number): string =>
  i < 26
    ? String.fromCharCode(65 + i)
    : letters(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26));

/** Next "Speaker X" label not used by any card of the meeting. */
export function nextLabel(cards: SpeakerCardDoc[]): string {
  const used = new Set(cards.map((c) => c.label));
  for (let i = 0; ; i++) if (!used.has(`Speaker ${letters(i)}`)) return `Speaker ${letters(i)}`;
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
): Promise<ApplyResult | null> {
  await MeetingDataModel.updateOne({ meetingId }, { $set: { turns, speakerCards: cards } });
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
  await SpeakerModel.updateOne(
    { _id: keepId },
    {
      $push: { voiceprints: { $each: drop.voiceprints } },
      ...(drop.anonymous ? {} : { $addToSet: { aliases: drop.name } }),
    },
  );
  const affected = await meetingsOfPerson(dropId);
  await MeetingDataModel.updateMany(
    { 'speakerCards.personId': dropId },
    { $set: { 'speakerCards.$[c].personId': keepId } },
    { arrayFilters: [{ 'c.personId': dropId }] },
  );
  await SpeakerModel.deleteOne({ _id: dropId });
  for (const m of affected) await applyNames(m);
  return affected;
}

/** Make `intoDiar` absorb `fromDiar`: all its turns, and (when both are known) its person. */
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
    await save(meetingId, turns, rest);
    await mergePeople(keep, drop);
    return applyNames(meetingId);
  }
  if (!into.personId) into.personId = from.personId;
  return save(meetingId, turns, rest);
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
  const id = `${diar.replace(/~\d+$/, '')}~${cards.length + 1}`;
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

/** Give one line to another speaker of the meeting. */
export async function reassignLine(
  meetingId: string,
  lineIndex: number,
  toDiar: string,
): Promise<ApplyResult | null> {
  const { turns, cards, lines, speakerMap } = await load(meetingId);
  const line = lines[lineIndex];
  const target = cards.find((c) => c.diar === toDiar);
  if (!line || !target) throw new EditError('Line or speaker not found.');
  const mine = turnsOfLine(turns, line, speakerMap);
  if (!mine.length) throw new EditError('Could not find the speech of that line.');
  for (const t of mine) {
    const from = cards.find((c) => c.diar === t.speaker);
    const sec = t.end - t.start;
    if (from) from.speakerSec = Math.max(0, Math.round((from.speakerSec - sec) * 10) / 10);
    target.speakerSec = Math.round((target.speakerSec + sec) * 10) / 10;
    t.speaker = toDiar;
  }
  return save(meetingId, turns, cards);
}

/**
 * Name a voice. If `usePersonId` is given the voice is linked to that existing person (their
 * voiceprints combine); otherwise the card's own person is renamed, or created if it has none.
 * Returns the meetings whose lines changed.
 */
export async function nameSpeaker(
  meetingId: string,
  workspaceId: string,
  diar: string,
  name: string,
  usePersonId?: string,
): Promise<{ personId: string; changed: string[]; meetings: string[] }> {
  const { cards } = await load(meetingId);
  const card = cards.find((c) => c.diar === diar);
  if (!card) throw new EditError('Speaker not found.');
  let personId = card.personId;
  if (usePersonId) {
    if (personId && personId !== usePersonId) await mergePeople(usePersonId, personId);
    personId = usePersonId;
    card.personId = personId;
    card.status = 'solid';
    await MeetingDataModel.updateOne({ meetingId }, { $set: { speakerCards: cards } });
    const meetings = await meetingsOfPerson(personId);
    const changed: string[] = [];
    for (const m of meetings) if ((await applyNames(m))?.namesChanged) changed.push(m);
    return { personId, changed, meetings };
  }
  if (!personId) {
    const created = await SpeakerModel.create({
      workspaceId: new Types.ObjectId(workspaceId),
      name,
      anonymous: false,
      origin: { meetingId: new Types.ObjectId(meetingId), diar },
    });
    personId = String(created._id);
    card.personId = personId;
  }
  card.status = 'solid';
  await MeetingDataModel.updateOne({ meetingId }, { $set: { speakerCards: cards } });
  const r = await renamePerson(personId, name);
  return { personId, changed: r.changed, meetings: r.meetings };
}
