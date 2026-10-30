import { Types } from 'mongoose';
import { SpeakerModel, type SpeakerCardDoc, type SpeakerDoc } from '../../models/index.js';

/** Shown when a voice profile was deleted and the card no longer points at a person. */
export const UNKNOWN_SPEAKER = 'Unknown speaker';

/** "Unknown" is a voice nobody could place; "Unknown speaker" is one whose profile was deleted. Neither is a participant. */
export const isUnknownName = (name: string): boolean => name === 'Unknown' || name === UNKNOWN_SPEAKER;

/**
 * Name shown for a card. A real name (including someone who has left) wins. A deleted voice, or a
 * card whose person no longer exists, is "Unknown speaker". Anything else keeps the meeting label.
 */
export function displayName(card: SpeakerCardDoc, people: Map<string, SpeakerDoc>): string {
  const person = card.personId ? people.get(card.personId) : undefined;
  if (person && !person.anonymous) return person.name;
  // the flag belongs to a card with no person: once the card is given one (an unnamed voice), its label shows again
  if ((card.voiceDeleted && !card.personId) || (card.personId && !person)) return UNKNOWN_SPEAKER;
  return card.label;
}

export async function peopleOf(personIds: (string | null)[]): Promise<Map<string, SpeakerDoc>> {
  const ids = personIds.filter((x): x is string => !!x).map((x) => new Types.ObjectId(x));
  const docs = ids.length
    ? await SpeakerModel.find({ _id: { $in: ids } }).lean<SpeakerDoc[]>()
    : [];
  return new Map(docs.map((d) => [String(d._id), d]));
}
