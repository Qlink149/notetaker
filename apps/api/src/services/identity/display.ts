import { Types } from 'mongoose';
import { SpeakerModel, type SpeakerCardDoc, type SpeakerDoc } from '../../models/index.js';

/** Name shown for a card: the person's real name once a human has typed it, else the meeting's label. */
export function displayName(card: SpeakerCardDoc, people: Map<string, SpeakerDoc>): string {
  const person = card.personId ? people.get(card.personId) : undefined;
  return person && !person.anonymous ? person.name : card.label;
}

export async function peopleOf(personIds: (string | null)[]): Promise<Map<string, SpeakerDoc>> {
  const ids = personIds.filter((x): x is string => !!x).map((x) => new Types.ObjectId(x));
  const docs = ids.length
    ? await SpeakerModel.find({ _id: { $in: ids } }).lean<SpeakerDoc[]>()
    : [];
  return new Map(docs.map((d) => [String(d._id), d]));
}
