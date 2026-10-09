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
  submitIdentify,
  PyannoteError,
  submitVoiceprint,
  uploadMedia,
  type PyannoteModel,
  type VoiceprintRef,
} from '../pyannote/client.js';
import { analysisFlac, meetingMedia, runJob, scratchDir } from '../pyannote/jobs.js';
import { pyannoteSegments, shortTitle, speakerSeconds } from './identity.js';

export const IDENTITY_MODEL: PyannoteModel = 'precision-2';
/** Overnight defaults (DECISIONS #29); to be calibrated on audited data. */
export const DEFAULT_THRESHOLDS = { minScore: 60, minMargin: 10 };
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
      const counts = meeting.expectedParticipants
        ? { minSpeakers: 1, maxSpeakers: meeting.expectedParticipants + 2 }
        : {};
      const body = identifyBody(url, { model: IDENTITY_MODEL, voiceprints: refs, ...counts });
      const hash = createHash('sha1')
        .update(refs.map((r) => r.label).join(','))
        .digest('hex')
        .slice(0, 8);
      const tag = `identity-${hash}`;
      const stored = await P2PyannoteResponseModel.findOne({
        meetingId,
        kind: 'identify',
        model: IDENTITY_MODEL,
        tag,
        status: 'succeeded',
      }).lean();
      if (!stored && !submitNew)
        throw new Error('NO_STORED_IDENTIFY: no stored identify job; pass submitNew to run one');
      const doc = await runJob(
        {
          meetingId,
          kind: 'identify',
          model: IDENTITY_MODEL,
          tag: `identity-${hash}`,
          body,
          submit: () =>
            submitIdentify(url, { model: IDENTITY_MODEL, voiceprints: refs, ...counts }),
        },
        log,
      );
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
      if (!budget) await enrol(personId, diar, clips.slice(0, 1));
    } else if (sec >= MIN_SPEECH_FOR_PERSON_SEC && clips.length) {
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
      await enrol(personId, diar, clips);
      status = res?.status === 'low-margin' || res?.status === 'taken' ? 'review' : 'new';
    } else {
      status = 'review';
    }
    cards.push({
      diar,
      label,
      personId,
      speakerSec: Math.round(sec * 10) / 10,
      match,
      candidate:
        !match && res?.candidate && (res.score > 0 || res.margin !== 0)
          ? { name: res.candidate, score: res.score, status: res.status }
          : null,
      status,
      clips: clips.map((c) => ({ start: c.start, end: c.end, quality: c.quality })),
    });
  }
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
