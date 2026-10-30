import {
  computeCoverage,
  labelSpeakersByTime,
  applySpeakerMerges,
  mergeConfusableSpeakers,
  renameInSummary,
  turnsToLines,
  type DiarSegment,
  type SpeakerMerge,
  type DiarizationOutput,
} from '@meetingid/pipeline';
import type { Line, Turn } from '@meetingid/shared';
import {
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  type SpeakerCardDoc,
} from '../../models/index.js';
import { P2JoinModel, P2PyannoteResponseModel } from '../../models/phase2.js';
import { env } from '../../config/env.js';
import { applyMeetingTaskFollow } from '../tasks/reconcile.js';
import { displayName, isUnknownName, peopleOf } from './display.js';

export { displayName, peopleOf } from './display.js';

/** "Meeting-21-9-2026 (acceptance, ts fix)" → "21/9", "AOM Meeting part 1 (acceptance)" → "AOM". */
export function shortTitle(title: string): string {
  const t = title.replace(/\(.*?\)/g, '').trim();
  const date = /^(?:Meeting-)?(\d{1,2})-(\d{1,2})-\d{4}$/.exec(t);
  if (date) return `${date[1]}/${date[2]}`;
  // "Meeting 8 Oct (WhatsApp audio)" must not become "Meeting": skip generic leading words and keep
  // two words then (at most 18 characters); otherwise the first word, as before
  const words = t.split(/\s+/).filter(Boolean);
  const rest = words.filter((w, i) => i > 0 || !/^(meeting|call|recording|audio)$/i.test(w));
  const skipped = rest.length < words.length && rest.length > 0;
  const picked = (rest.length ? rest : words).slice(0, skipped ? 2 : 1).join(' ');
  return picked.length > 18 ? picked.slice(0, 18).trim() : picked || t;
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
): Promise<{ segments: DiarSegment[]; all: DiarSegment[]; merges: SpeakerMerge[] } | null> {
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
  const raw = doc.output as DiarizationOutput;
  // One voice that pyannote split in two is merged here. The decision is taken once, before the meeting
  // has cards, and stored with the meeting; later calls apply the stored decision, so the transcript,
  // the cards and the identification always see the same speakers. A meeting made before this existed
  // has cards and no stored decision, so it is left as it was. The stored pyannote reply is never changed.
  const state = await MeetingDataModel.findOne(
    { meetingId },
    { speakerCards: 1, speakerMerges: 1 },
  ).lean();
  const hasCards = (state?.speakerCards ?? []).length > 0;
  const stored = (state?.speakerMerges ?? []) as SpeakerMerge[];
  const { output: out, merges } = hasCards
    ? { output: applySpeakerMerges(raw, stored), merges: stored }
    : env().SPEAKER_AUTOMERGE
      ? mergeConfusableSpeakers(raw)
      : { output: raw, merges: [] as SpeakerMerge[] };
  const segments = out.exclusiveDiarization ?? out.diarization;
  return { segments, all: out.diarization ?? segments, merges };
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
  await MeetingDataModel.updateOne(
    { meetingId },
    { $set: { speakerCards: cards, speakerMerges: pya.merges } },
  );
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

/** What happened to the meeting's summary after a speaker change. */
export type SummaryFollow = 'none' | 'unchanged' | 'updated' | 'needs_refresh';

export interface ApplyResult {
  lines: number;
  coverage: number;
  /** True when any line's speaker name differs from before. */
  namesChanged: boolean;
  /** "updated": names swapped in the summary in place; "needs_refresh": marked out of date for a new one. */
  summary: SummaryFollow;
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
        participants: names.filter((n) => !isUnknownName(n)),
        unknownCount: names.filter(isUnknownName).length,
      },
    },
  );
  const namesChanged = before !== JSON.stringify(lines.map((l) => l.speakerName));
  // The summary follows the new names: swapped in place when that is safe, otherwise marked out of date. This
  // runs for every meeting a change reaches, including those changed by naming a voice in another meeting.
  const summary = namesChanged
    ? await followNames(
        meetingId,
        (data.speakerMap ?? {}) as Record<string, string>,
        speakerMap,
        data.lines as Line[],
        lines,
      )
    : 'none';
  return { lines: lines.length, coverage: coverage.ratio, namesChanged, summary };
}

/**
 * Bring a written summary up to date with renamed speakers without a new summary (client request, 20 Oct): the
 * names are swapped in the summary text and action items. When the change is more than a rename (speakers
 * joined, split, a line moved to someone else) or a swap could be wrong, the summary is marked out of date
 * instead and a person decides whether to write a new one.
 */
async function followNames(
  meetingId: string,
  previousMap: Record<string, string>,
  speakerMap: Record<string, string>,
  linesBefore: Line[],
  linesAfter: Line[],
): Promise<SummaryFollow> {
  const m = await MeetingModel.findById(meetingId, {
    summary: 1,
    actionItems: 1,
    summaryNames: 1,
    summaryOutdated: 1,
  }).lean();
  if (!m?.summary) return 'none';
  const outdated = async (set: Record<string, unknown> = {}): Promise<'needs_refresh'> => {
    await MeetingModel.updateOne({ _id: meetingId }, { $set: { ...set, summaryOutdated: true } });
    return 'needs_refresh';
  };
  // The names the summary was written with; a summary from before this was recorded used the previous names,
  // unless it was already out of date (then its names are unknown).
  const from =
    (m.summaryNames as Record<string, string> | null | undefined) ??
    (m.summaryOutdated ? null : previousMap);
  if (!from) return outdated();
  // Only a rename may be followed in place: every line must keep its place and speaker, under the new name.
  const renamed = new Map<string, string>();
  for (const [id, was] of Object.entries(previousMap)) {
    const now = speakerMap[id];
    if (now === undefined) continue;
    if (renamed.has(was) && renamed.get(was) !== now) return outdated({ summaryNames: from });
    renamed.set(was, now);
  }
  const key = (l: Line, name: string): string => `${l.start}|${l.end}|${name}`;
  const expected = linesBefore.map((l) => key(l, renamed.get(l.speakerName) ?? l.speakerName));
  const actual = linesAfter.map((l) => key(l, l.speakerName));
  if (JSON.stringify(expected) !== JSON.stringify(actual)) return outdated({ summaryNames: from });

  const previousItems = (m.actionItems ?? []).map((a) => ({
    speakerName: a.speakerName,
    text: a.text,
  }));
  const r = renameInSummary({
    summary: m.summary,
    actionItems: previousItems,
    from,
    to: speakerMap,
    spokenText: linesAfter.map((l) => l.textRoman).join('\n'),
  });
  const itemsMoved = r.actionItems.some(
    (a, i) => a.speakerName !== previousItems[i]?.speakerName || a.text !== previousItems[i]?.text,
  );
  if (r.status === 'needs_refresh') {
    await outdated({ summaryNames: from, actionItems: r.actionItems });
    // The summary text waits for a refresh, but the action items already name the corrected speakers,
    // so filed tasks follow now rather than staying with someone who has left this meeting.
    if (itemsMoved) await applyMeetingTaskFollow(meetingId, previousItems, r.actionItems);
    return 'needs_refresh';
  }
  await MeetingModel.updateOne(
    { _id: meetingId },
    {
      $set: {
        ...(r.status === 'updated' ? { summary: r.summary, actionItems: r.actionItems } : {}),
        summaryNames: speakerMap,
      },
    },
  );
  if (r.status === 'updated' && itemsMoved)
    await applyMeetingTaskFollow(meetingId, previousItems, r.actionItems);
  return r.status;
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
