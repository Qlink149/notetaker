import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Types } from 'mongoose';
import {
  buildScoreMatrixFromSegments,
  buildSpeakerLevelMatrix,
  labelSpeakersByTime,
  overlapRanges,
  pickVoiceprints,
  resolveNames,
  selectClips,
  type DiarSegment,
  type DiarizationOutput,
  type NameResolution,
  type ScoredSegment,
  type VoiceClip,
} from '@meetingid/pipeline';
import {
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  type SpeakerCardDoc,
  type SpeakerDoc,
} from '../../models/index.js';
import { P2IdentityRunModel, P2PyannoteResponseModel } from '../../models/phase2.js';
import { cutFlac } from '../audio/ffmpeg.js';
import {
  identifyBody,
  speakerCountHint,
  submitIdentify,
  PyannoteError,
  submitVoiceprint,
  uploadMedia,
  type PyannoteModel,
  type VoiceprintRef,
} from '../pyannote/client.js';
import {
  analysisFlac,
  meetingMedia,
  runJob,
  scratchDir,
  submitOrResume,
  type JobSpec,
} from '../pyannote/jobs.js';
import { pyannoteSegments, shortTitle, speakerSeconds } from './identity.js';

export const IDENTITY_MODEL: PyannoteModel = 'precision-2';
/**
 * A voice is named automatically only at this score. On 16 Oct two different people matched at 62 and 63 while
 * every correct match scored 84 or more, so 60 (the overnight default, DECISIONS #29) named absent people.
 */
export const DEFAULT_THRESHOLDS = { minScore: 75, minMargin: 10 };
/** Below the automatic bar but this close: shown as "possibly X", for a person to confirm. Never named on its own. */
export const POSSIBLE_MIN_SCORE = 60;
/** A speaker needs this much speech before a new person is created for them. */
const MIN_SPEECH_FOR_PERSON_SEC = 15;

type Log = (msg: string) => void;

/** Run async work over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/**
 * The closest known person for a voice that was not named: shown on its card, and offered for a one-click
 * confirmation ("possible") when it scored at least POSSIBLE_MIN_SCORE but under the automatic bar.
 */
export function cardCandidate(res: NameResolution | undefined): SpeakerCardDoc['candidate'] {
  if (!res?.candidate || (res.candidateScore <= 0 && res.score <= 0)) return null;
  return {
    name: res.candidate,
    personId: res.candidateId,
    score: res.candidateScore,
    status:
      res.status === 'below-threshold' && res.candidateScore >= POSSIBLE_MIN_SCORE
        ? 'possible'
        : res.status,
  };
}

/** Create voiceprints for `clips` of one speaker and store them on the person. Returns how many were added. */
export async function addVoiceprints(
  meetingId: string,
  personId: string,
  diar: string,
  clips: VoiceClip[],
  log: Log = () => undefined,
): Promise<number> {
  if (!clips.length) return 0;
  const person = await SpeakerModel.findById(personId).lean<SpeakerDoc>();
  if (!person) throw new Error(`person ${personId} not found`);
  const have = new Set(
    person.voiceprints
      .filter((v) => String(v.meetingId) === meetingId && v.clip)
      .map((v) => Math.round(v.clip!.start)),
  );
  const todo = clips.filter((c) => !have.has(Math.round(c.start)));
  if (!todo.length) return 0;
  const flac = await analysisFlac(meetingId);
  const added = await mapLimit(todo, 3, async (clip) => {
    const key = `${Math.round(clip.start)}`;
    const file = scratchDir(meetingId, `clip-${diar}-${key}.flac`);
    await mkdir(dirname(file), { recursive: true });
    await cutFlac(flac, file, clip.start, clip.end);
    const media = await uploadMedia(file, `p2-clip-${meetingId}-${diar}-${key}.flac`, 'voiceprint');
    const doc = await runJob(
      {
        meetingId,
        kind: 'voiceprint',
        model: IDENTITY_MODEL,
        tag: `vp-${diar}-${key}`,
        body: { url: media, model: IDENTITY_MODEL },
        submit: () => submitVoiceprint(media, IDENTITY_MODEL),
      },
      log,
    );
    const voiceprint = (doc.output as { voiceprint?: string } | null)?.voiceprint;
    if (!voiceprint) return 0;
    await SpeakerModel.updateOne(
      { _id: personId },
      {
        $push: {
          voiceprints: {
            id: new Types.ObjectId().toString(),
            source: 'meeting',
            audioUrl: '',
            voiceprint,
            model: IDENTITY_MODEL,
            meetingId: new Types.ObjectId(meetingId),
            clip: { start: clip.start, end: clip.end },
            quality: clip.quality,
          },
        },
      },
    );
    return 1;
  });
  return added.reduce<number>((a, b) => a + b, 0);
}

/** Clips for one speaker of one meeting, from pyannote's own segments (plan C2). */
export function clipsFor(
  diar: string,
  exclusive: DiarSegment[],
  all: DiarSegment[],
  meetingSec: number,
  maxClips = 3,
): VoiceClip[] {
  return selectClips({
    speaker: diar,
    exclusive,
    overlaps: overlapRanges(all),
    meetingSec,
    maxClips,
  });
}

export interface IdentityReport {
  meetingId: string;
  title: string;
  jobId: string | null;
  voiceprintsSent: number;
  cards: SpeakerCardDoc[];
  resolutions: Record<string, NameResolution>;
  newPeople: string[];
  linked: { label: string; person: string; score: number; margin: number }[];
  /** Things that did not complete, e.g. pyannote credits exhausted (rerun later; it is idempotent). */
  warnings: string[];
}

/** The known people's voiceprints to compare a meeting against (this meeting's own voices are left out). */
async function knownVoices(
  meetingId: string,
  workspaceId: string,
): Promise<{
  refs: VoiceprintRef[];
  labelToPerson: Record<string, string>;
  names: Record<string, string>;
}> {
  const people = await SpeakerModel.find({
    workspaceId: new Types.ObjectId(workspaceId),
  }).lean<SpeakerDoc[]>();
  const others = people.filter((p) => String(p.origin?.meetingId) !== meetingId);
  const labelToPerson: Record<string, string> = {};
  const items = others.flatMap((p) =>
    p.voiceprints
      .filter((v) => (v.voiceprint ?? v.id) && (v.model ?? IDENTITY_MODEL) === IDENTITY_MODEL)
      .map((v, n) => ({
        personId: String(p._id),
        quality: v.quality ?? null,
        label: `${p._id}-${n}`,
        voiceprint: v.voiceprint ?? v.id,
      })),
  );
  const picked = pickVoiceprints(items, 50);
  const refs: VoiceprintRef[] = picked.map((v) => {
    labelToPerson[v.label] = v.personId;
    return { label: v.label, voiceprint: v.voiceprint };
  });
  const names = Object.fromEntries(others.map((p) => [String(p._id), p.name]));
  return { refs, labelToPerson, names };
}

/** The pyannote identify job for a meeting against a set of voiceprints; its tag names that exact set. */
function identifySpec(
  meetingId: string,
  url: string,
  refs: VoiceprintRef[],
  expectedParticipants: Parameters<typeof speakerCountHint>[0],
): JobSpec {
  const counts = speakerCountHint(expectedParticipants);
  const hash = createHash('sha1')
    .update(refs.map((r) => r.label).join(','))
    .digest('hex')
    .slice(0, 8);
  return {
    meetingId,
    kind: 'identify',
    model: IDENTITY_MODEL,
    tag: `identity-${hash}`,
    body: identifyBody(url, { model: IDENTITY_MODEL, voiceprints: refs, ...counts }),
    submit: () => submitIdentify(url, { model: IDENTITY_MODEL, voiceprints: refs, ...counts }),
  };
}

/**
 * Start the identify job without waiting for it, so pyannote works on it while the meeting is still being
 * transcribed. `identifyMeeting` later finds it by the same key and only collects the result. Returns false
 * when there is nothing to compare against (no known voiceprints) or the meeting is gone.
 */
export async function startIdentify(
  meetingId: string,
  workspaceId: string,
  log: Log = () => undefined,
): Promise<boolean> {
  const meeting = await MeetingModel.findById(meetingId).lean();
  if (!meeting) return false;
  const { refs } = await knownVoices(meetingId, workspaceId);
  if (!refs.length) return false;
  const url = await meetingMedia(meetingId);
  await submitOrResume(identifySpec(meetingId, url, refs, meeting.expectedParticipants), log);
  return true;
}

/**
 * Work out who each voice in a meeting is. Sends every known voiceprint (best per person first,
 * at most 50) to pyannote `identify`, scores our own speakers from its per-segment output,
 * resolves names one-to-one with thresholds, then gives every voice that is not recognised a new
 * anonymous person ("Speaker B (Meeting AOM)") with voiceprints from this meeting. Recognised
 * voices gain one more voiceprint. Stores the cards on the meeting and every score in p2_identity_runs.
 */
export async function identifyMeeting(
  meetingId: string,
  workspaceId: string,
  {
    thresholds = DEFAULT_THRESHOLDS,
    log = () => undefined,
    submitNew = false,
    previewOnly = false,
    budget,
  }: {
    thresholds?: { minScore: number; minMargin: number };
    log?: Log;
    /** Allow submitting a new full-meeting identify job; without it only stored results are used. */
    submitNew?: boolean;
    /** Compute who each voice is without creating people, voiceprints or cards. */
    previewOnly?: boolean;
    /** Pay-per-voiceprint cap shared across meetings: one clip per new voice, none for recognised voices, stop at `left`. */
    budget?: { left: number };
  } = {},
): Promise<IdentityReport> {
  const meeting = await MeetingModel.findById(meetingId).lean();
  if (!meeting) throw new Error(`meeting ${meetingId} not found`);
  const short = shortTitle(meeting.title);
  const pya = await pyannoteSegments(meetingId);
  if (!pya) throw new Error(`no stored pyannote diarization for ${meetingId}`);
  const seconds = speakerSeconds(pya.segments);
  const labels = labelSpeakersByTime(pya.segments);
  const order = [
    ...new Set([...pya.segments].sort((a, b) => a.start - b.start).map((s) => s.speaker)),
  ];
  const meetingSec = meeting.durationSec ?? Math.max(...pya.segments.map((s) => s.end));

  // 1. known voices (this meeting's own are excluded so a rerun does not match itself)
  const { refs, labelToPerson, names } = await knownVoices(meetingId, workspaceId);

  // 2. identify
  let jobId: string | null = null;
  let resolutions: Record<string, NameResolution> = {};
  let matrix: Record<string, Record<string, number>> = {};
  const warnings: string[] = [];
  let creditsOut = false;
  const outOfCredits = (err: unknown): boolean =>
    err instanceof PyannoteError && err.status === 402;
  if (refs.length) {
    try {
      const url = await meetingMedia(meetingId);
      const spec = identifySpec(meetingId, url, refs, meeting.expectedParticipants);
      const stored = await P2PyannoteResponseModel.findOne({
        meetingId,
        kind: 'identify',
        model: IDENTITY_MODEL,
        tag: spec.tag,
        status: 'succeeded',
      }).lean();
      if (!stored && !submitNew)
        throw new Error('NO_STORED_IDENTIFY: no stored identify job; pass submitNew to run one');
      // a job started early (during transcription) is picked up here instead of being submitted again
      const doc = await runJob(spec, log);
      jobId = doc.jobId;
      const out = doc.output as DiarizationOutput & { identification?: ScoredSegment[] };
      // pyannote's own per-speaker scores first; segment-level means only for voices it split differently
      const speakerLevel = buildSpeakerLevelMatrix(
        pya.segments,
        {
          diarization: out.exclusiveDiarization ?? out.diarization,
          voiceprints: out.voiceprints ?? [],
        },
        labelToPerson,
      );
      const segmentLevel = speakerLevel.unmapped.length
        ? buildScoreMatrixFromSegments(
            pya.segments.filter((s) => speakerLevel.unmapped.includes(s.speaker)),
            (out.identification ?? []) as ScoredSegment[],
            labelToPerson,
          )
        : {};
      matrix = { ...segmentLevel, ...speakerLevel.matrix };
      resolutions = resolveNames(order, matrix, { ...thresholds, names });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('NO_STORED_IDENTIFY')) {
        warnings.push('identify not run: no stored result and new jobs were not allowed');
      } else if (outOfCredits(err)) {
        creditsOut = true;
        warnings.push('pyannote credits exhausted: identify not run for this meeting');
      } else throw err;
      resolutions = resolveNames(order, {}, { ...thresholds, names });
    }
  } else {
    resolutions = resolveNames(order, {}, { ...thresholds, names });
  }
  const enrol = async (personId: string, diar: string, clips: VoiceClip[]): Promise<void> => {
    if (budget) clips = clips.slice(0, Math.min(1, budget.left));
    if (creditsOut || !clips.length) return;
    try {
      await addVoiceprints(meetingId, personId, diar, clips, log);
      if (budget) budget.left -= clips.length;
    } catch (err) {
      if (!outOfCredits(err)) throw err;
      creditsOut = true;
      warnings.push('pyannote credits exhausted: voiceprints not created (rerun when topped up)');
    }
  };

  if (previewOnly) {
    return {
      meetingId,
      title: meeting.title,
      jobId,
      voiceprintsSent: refs.length,
      cards: [],
      resolutions,
      newPeople: [],
      linked: [],
      warnings,
    };
  }

  // 3. cards, new people, voiceprints
  // Voiceprints are created for all the voices at the same time afterwards (each is a pyannote job that mostly
  // waits); with a shared budget they stay one at a time in order, since each draws from it.
  const enrolments: (() => Promise<void>)[] = [];
  const enrolNow = (personId: string, diar: string, clips: VoiceClip[]): Promise<void> | void => {
    if (budget) return enrol(personId, diar, clips);
    enrolments.push(() => enrol(personId, diar, clips));
  };
  const cards: SpeakerCardDoc[] = [];
  const newPeople: string[] = [];
  const linked: IdentityReport['linked'] = [];
  for (const [diar, sec] of seconds) {
    const res = resolutions[diar];
    const clips = clipsFor(diar, pya.segments, pya.all, meetingSec);
    const label = labels[diar] ?? diar;
    let personId: string | null = null;
    let status: SpeakerCardDoc['status'] = 'new';
    let match: SpeakerCardDoc['match'] = null;
    if (res?.personId) {
      personId = res.personId;
      status = 'solid';
      match = { personId, name: res.name ?? personId, score: res.score, margin: res.margin };
      linked.push({ label, person: res.name ?? personId, score: res.score, margin: res.margin });
      // No voiceprint is added for an automatic match: a wrong match would teach the person's profile someone
      // else's voice. Clips are learned once a person confirms or names the voice (learnConfirmedVoices).
    } else if (res?.status !== 'taken' && sec >= MIN_SPEECH_FOR_PERSON_SEC && clips.length) {
      // (A voice whose best match is a known person already paired with another voice of this meeting is
      // left unlinked, with that person shown as the closest match, instead of becoming a new anonymous
      // person: that was how one speaker ended up in the library twice.)
      const existing = await SpeakerModel.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        'origin.meetingId': new Types.ObjectId(meetingId),
        'origin.diar': diar,
      }).lean<SpeakerDoc>();
      const person =
        existing ??
        (await SpeakerModel.create({
          workspaceId: new Types.ObjectId(workspaceId),
          name: `${label} (Meeting ${short})`,
          anonymous: true,
          origin: { meetingId: new Types.ObjectId(meetingId), diar },
        }));
      personId = String(person._id);
      newPeople.push(person.name);
      await enrolNow(personId, diar, clips);
      status = res?.status === 'low-margin' ? 'review' : 'new';
    } else {
      status = 'review';
    }
    cards.push({
      diar,
      label,
      personId,
      speakerSec: Math.round(sec * 10) / 10,
      match,
      candidate: match ? null : cardCandidate(res),
      status,
      clips: clips.map((c) => ({ start: c.start, end: c.end, quality: c.quality })),
    });
  }
  await mapLimit(enrolments, 4, (run) => run());
  await MeetingDataModel.updateOne({ meetingId }, { $set: { speakerCards: cards } });
  await P2IdentityRunModel.create({
    meetingId: new Types.ObjectId(meetingId),
    jobId: jobId ?? 'none',
    model: IDENTITY_MODEL,
    thresholds,
    labelToPerson,
    names,
    matrix,
    resolutions,
  });
  return {
    meetingId,
    title: meeting.title,
    jobId,
    voiceprintsSent: refs.length,
    cards,
    resolutions,
    newPeople,
    linked,
    warnings,
  };
}

/**
 * Add voiceprints for every voice of a meeting that a person named or confirmed (cards marked `confirmed`). Only
 * confirmed voices are learned, so a wrong automatic match never changes anyone's profile. Idempotent: clips the
 * person already has from this meeting are skipped.
 */
export async function learnConfirmedVoices(
  meetingId: string,
  log: Log = () => undefined,
): Promise<number> {
  const data = await MeetingDataModel.findOne({ meetingId }, { speakerCards: 1 }).lean();
  let added = 0;
  for (const c of (data?.speakerCards ?? []) as SpeakerCardDoc[]) {
    if (!c.confirmed || !c.personId || !c.clips?.length) continue;
    if (!(await SpeakerModel.exists({ _id: c.personId }))) continue;
    added += await addVoiceprints(
      meetingId,
      c.personId,
      c.diar,
      c.clips.map((x) => ({ speaker: c.diar, start: x.start, end: x.end, quality: x.quality })),
      log,
    );
  }
  return added;
}
