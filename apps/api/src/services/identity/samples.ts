import { createHash } from 'node:crypto';
import { MeetingModel, type VoiceprintDoc } from '../../models/index.js';

/**
 * What the browser calls one voice sample. A sample has no id of its own, and the `id` of an old recorded one is
 * the voiceprint itself, so neither is ever sent out: this is a short hash of it, enough to tell one sample of a
 * person from another.
 */
export const sampleKey = (v: Pick<VoiceprintDoc, 'id'>): string =>
  createHash('sha256').update(`sample:${v.id}`).digest('hex').slice(0, 16);

/** A sample that is still compared with new voices. */
export const isActiveSample = (v: Pick<VoiceprintDoc, 'removedAt'>): boolean => !v.removedAt;

/** A default voice shorter than this rarely matches anyone (28 Oct, all stored identify runs), so it is passed over. */
export const MIN_MAIN_SECONDS = 15;

/** The ids of those meetings that still exist, i.e. whose recording a clip can still be played from. */
export async function meetingsStillThere(
  voiceprints: Pick<VoiceprintDoc, 'meetingId'>[],
): Promise<Set<string>> {
  const ids = [...new Set(voiceprints.flatMap((v) => (v.meetingId ? [String(v.meetingId)] : [])))];
  if (!ids.length) return new Set();
  const found = await MeetingModel.find({ _id: { $in: ids } }, { _id: 1 }).lean();
  return new Set(found.map((m) => String(m._id)));
}

/**
 * The one sample of a person that new voices are compared with (28 Oct). The one chosen on the Speakers page, if it
 * is still usable; otherwise the voice the person recorded for themselves (the latest one); otherwise the first
 * sample that can still be heard and is long enough; otherwise the first that can still be heard; otherwise the
 * first. The others stay on the profile as spares to swap in. `usable` says whether pyannote can take the sample
 * at all (it has a voiceprint of the pinned model).
 */
export function mainSample<T extends VoiceprintDoc>(
  voiceprints: T[],
  mainSampleId: string | null | undefined,
  meetingsThere: Set<string>,
  usable: (v: T) => boolean = () => true,
): T | undefined {
  const pool = voiceprints.filter((v) => isActiveSample(v) && usable(v));
  const chosen = mainSampleId ? pool.find((v) => v.id === mainSampleId) : undefined;
  if (chosen) return chosen;
  const recorded = pool.filter((v) => v.source === 'enrolment').at(-1);
  if (recorded) return recorded;
  const heard = (v: T) =>
    Boolean(v.audioUrl) ||
    Boolean(v.meetingId && v.clip && meetingsThere.has(String(v.meetingId)));
  const long = (v: T) => (v.clip ? v.clip.end - v.clip.start : 0) >= MIN_MAIN_SECONDS;
  return pool.find((v) => heard(v) && long(v)) ?? pool.find(heard) ?? pool[0];
}
