import { Types } from 'mongoose';
import {
  computeCoverage,
  labelSpeakersByTime,
  turnsToLines,
  type DiarSegment,
  type DiarizationOutput,
} from '@meetingid/pipeline';
import type { Line, Turn } from '@meetingid/shared';
import {
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  type SpeakerCardDoc,
  type SpeakerDoc,
} from '../../models/index.js';
import { P2JoinModel, P2PyannoteResponseModel } from '../../models/phase2.js';

/** "Meeting-21-9-2026 (acceptance, ts fix)" → "21/9", "AOM Meeting part 1 (acceptance)" → "AOM". */
export function shortTitle(title: string): string {
  const t = title.replace(/\(.*?\)/g, '').trim();
  const date = /^(?:Meeting-)?(\d{1,2})-(\d{1,2})-\d{4}$/.exec(t);
  if (date) return `${date[1]}/${date[2]}`;
  return t.split(/\s+/)[0] ?? t;
}

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

/** Seconds each pyannote speaker talks in the exclusive diarization, largest first. */
export function speakerSeconds(segments: DiarSegment[]): Map<string, number> {
  const t = new Map<string, number>();
  for (const s of segments) t.set(s.speaker, (t.get(s.speaker) ?? 0) + (s.end - s.start));
  return new Map([...t].sort((a, b) => b[1] - a[1]));
}

/** The meeting's stored pyannote diarization (exclusive segments, falling back to plain). */
export async function pyannoteSegments(
  meetingId: string,
  model = 'precision-2',
): Promise<{ segments: DiarSegment[]; all: DiarSegment[] } | null> {
  // The pipeline's own run is preferred over the Stage A experiment run.
  const docs = await P2PyannoteResponseModel.find({
    meetingId,
    kind: 'diarize',
    model,
    tag: { $in: ['pipeline', 'stageA'] },
    status: 'succeeded',
  }).lean();
  const usable = docs.filter((d) => {
    const o = d.output as Partial<DiarizationOutput> | null;
    return Boolean(o && (o.exclusiveDiarization ?? o.diarization));
  });
  const doc = usable.find((d) => d.tag === 'pipeline') ?? usable[0];
  if (!doc) return null;
  const out = doc.output as DiarizationOutput;
  const segments = out.exclusiveDiarization ?? out.diarization;
  return { segments, all: out.diarization ?? segments };
}

/**
 * One card per pyannote speaker, labelled "Speaker A…" by speaking time. Existing cards are kept
 * (they hold people and edits); otherwise skeleton cards are created and saved.
 */
export async function ensureCards(meetingId: string): Promise<SpeakerCardDoc[]> {
  const data = await MeetingDataModel.findOne({ meetingId }, { speakerCards: 1 }).lean();
  if ((data?.speakerCards ?? []).length > 0) return data!.speakerCards as SpeakerCardDoc[];
  const pya = await pyannoteSegments(meetingId);
  if (!pya) return [];
  const labels = labelSpeakersByTime(pya.segments);
  const cards: SpeakerCardDoc[] = [...speakerSeconds(pya.segments)].map(([diar, sec]) => ({
    diar,
    label: labels[diar] ?? diar,
    personId: null,
    speakerSec: Math.round(sec * 10) / 10,
    match: null,
    candidate: null,
    status: 'new' as const,
    clips: [],
  }));
  await MeetingDataModel.updateOne({ meetingId }, { $set: { speakerCards: cards } });
  return cards;
}

export interface InstallResult {
  installed: boolean;
  reason?: string;
  speakers?: number;
  lines?: number;
  coverage?: number;
}

/**
 * Replace a meeting's Phase 1 speaker labels with the pyannote-based join (`p2_join_lines`,
 * method "joined"). Phase 1's turns, lines and speaker map are kept in `phase1` the first time.
 * Skipped when the join's coverage is below Phase 1's. Existing speaker cards are kept.
 */
export async function installJoin(meetingId: string): Promise<InstallResult> {
  const join = await P2JoinModel.findOne({ meetingId, method: 'joined' }).lean();
  const data = await MeetingDataModel.findOne({ meetingId }).lean();
  const meeting = await MeetingModel.findById(meetingId).lean();
  const pya = await pyannoteSegments(meetingId);
  if (!join || !data || !meeting || !pya)
    return { installed: false, reason: 'missing join, data or pyannote output' };
  if (!join.turns.length) return { installed: false, reason: 'no turns to join yet' };
  if (join.stats['coverageOk'] === false)
    return { installed: false, reason: 'join coverage is below Phase 1; Phase 1 lines kept' };

  const cards = await ensureCards(meetingId);

  const turns = join.turns as Turn[];
  const phase1 = data.phase1 ?? {
    turns: data.turns,
    lines: data.lines,
    speakerMap: data.speakerMap,
  };
  await MeetingDataModel.updateOne(
    { meetingId },
    { $set: { turns, speakerCards: cards, speakerSource: 'pyannote', phase1 } },
  );
  const changed = await applyNames(meetingId);
  return {
    installed: true,
    speakers: cards.length,
    lines: changed?.lines ?? 0,
    coverage: changed?.coverage,
  };
}

export interface ApplyResult {
  lines: number;
  coverage: number;
  /** True when any line's speaker name differs from before (summaries then need regenerating). */
  namesChanged: boolean;
}

/**
 * Recompute the speaker map, lines (re-merged), participants and coverage of a meeting from its
 * turns and speaker cards. Cheap and idempotent: call it after every rename, merge, split or reassign.
 */
export async function applyNames(meetingId: string): Promise<ApplyResult | null> {
  const data = await MeetingDataModel.findOne({ meetingId }).lean();
  if (!data || data.speakerSource !== 'pyannote') return null;
  const cards = (data.speakerCards ?? []) as SpeakerCardDoc[];
  const people = await peopleOf(cards.map((c) => c.personId));
  const speakerMap: Record<string, string> = { unknown: 'Unknown' };
  for (const c of cards) speakerMap[c.diar] = displayName(c, people);
  const before = JSON.stringify((data.lines as Line[]).map((l) => l.speakerName));
  const lines = turnsToLines(data.turns as Turn[], speakerMap);
  const coverage = computeCoverage(data.speechSegments ?? [], data.turns as Turn[]);
  await MeetingDataModel.updateOne({ meetingId }, { $set: { speakerMap, lines } });
  const names = [...new Set(lines.map((l) => l.speakerName))];
  await MeetingModel.updateOne(
    { _id: meetingId },
    {
      $set: {
        coverage,
        participants: names.filter((n) => n !== 'Unknown'),
        unknownCount: names.filter((n) => n === 'Unknown').length,
      },
    },
  );
  return {
    lines: lines.length,
    coverage: coverage.ratio,
    namesChanged: before !== JSON.stringify(lines.map((l) => l.speakerName)),
  };
}

/** Meetings where this person has a speaker card. */
export async function meetingsOfPerson(personId: string): Promise<string[]> {
  const docs = await MeetingDataModel.find(
    { 'speakerCards.personId': personId },
    { meetingId: 1 },
  ).lean();
  return docs.map((d) => String(d.meetingId));
}

/**
 * Give a person a real name. Every meeting where their voice was recognised (or confirmed) shows
 * the name from now on. Returns the meetings that changed.
 */
export async function renamePerson(
  personId: string,
  name: string,
): Promise<{ meetings: string[]; changed: string[] }> {
  await SpeakerModel.updateOne({ _id: personId }, { $set: { name, anonymous: false } });
  const meetings = await meetingsOfPerson(personId);
  const changed: string[] = [];
  for (const m of meetings) {
    const r = await applyNames(m);
    if (r?.namesChanged) changed.push(m);
  }
  return { meetings, changed };
}
