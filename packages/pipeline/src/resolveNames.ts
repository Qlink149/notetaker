/** Score of each person for each pyannote speaker: matrix[speaker][personId] (0–100). */
export type ScoreMatrix = Record<string, Record<string, number>>;

export interface IdentifyVoiceprintScores {
  speaker: string;
  confidence: Record<string, number>;
}

/**
 * Shown as "possibly" from here; named automatically only from CONFIDENT_SCORE.
 * Same numbers as POSSIBLE_MIN_SCORE and DEFAULT_THRESHOLDS.minScore in the API.
 */
export const POSSIBLE_SCORE = 60;
export const CONFIDENT_SCORE = 75;
/** A sub-confident voiceprint this far above the person's next one is a lone noisy max, not agreement. */
const LONE_SPIKE_GAP = 15;

/**
 * Moderate scores on speakers other than a confident match, or moderate scores covering half the
 * room when nobody matches confidently. Callers then drop every score under CONFIDENT_SCORE.
 */
function matchesTheRoom(scores: number[]): boolean {
  if (scores.length < 2) return false;
  const elevated = scores.filter((s) => s >= POSSIBLE_SCORE).length;
  const confident = scores.filter((s) => s >= CONFIDENT_SCORE).length;
  if (confident > 0 && elevated > confident) return true;
  return confident === 0 && elevated >= 2 && elevated / scores.length >= 0.5;
}

/**
 * A voiceprint that is a moderate match for half or more of the speakers is dropped. One confident
 * hit still counts, but its moderate scores on everyone else are dropped with it.
 */
export function resistHubVoiceprints(
  voiceprints: IdentifyVoiceprintScores[],
): IdentifyVoiceprintScores[] {
  const moderate = new Set<string>();
  if (voiceprints.length >= 2) {
    const labels = new Set<string>();
    for (const v of voiceprints) {
      for (const label of Object.keys(v.confidence)) labels.add(label);
    }
    for (const label of labels) {
      const scores = voiceprints.map((v) => v.confidence[label] ?? 0);
      if (matchesTheRoom(scores)) moderate.add(label);
    }
  }
  return voiceprints.map((v) => {
    const confidence: Record<string, number> = {};
    for (const [label, score] of Object.entries(v.confidence)) {
      if (moderate.has(label) && score < CONFIDENT_SCORE) continue;
      confidence[label] = score;
    }
    return { speaker: v.speaker, confidence };
  });
}

/**
 * Same rule after voiceprints have been collapsed to a person. One profile can clear 60 for most
 * speakers by a different voiceprint each time, with no single voiceprint looking like a hub.
 */
export function resistHubPeople(matrix: ScoreMatrix): ScoreMatrix {
  const speakers = Object.keys(matrix);
  if (speakers.length < 2) return matrix;
  const people = new Set<string>();
  for (const row of Object.values(matrix)) {
    for (const person of Object.keys(row)) people.add(person);
  }
  const moderate = new Set<string>();
  for (const person of people) {
    const scores = speakers.map((s) => matrix[s]?.[person] ?? 0);
    if (matchesTheRoom(scores)) moderate.add(person);
  }
  if (!moderate.size) return matrix;
  const out: ScoreMatrix = {};
  for (const [speaker, row] of Object.entries(matrix)) {
    const next: Record<string, number> = {};
    for (const [person, score] of Object.entries(row)) {
      if (moderate.has(person) && score < CONFIDENT_SCORE) continue;
      next[person] = score;
    }
    out[speaker] = next;
  }
  return out;
}

/**
 * Best voiceprint for a person, except a lone score in the "possible" band when another of that
 * person's voiceprints is much lower. The max of many unrelated prints otherwise clears 60 for
 * most speakers.
 */
export function voiceprintPersonScore(scores: number[]): number {
  const sorted = [...scores].filter((s) => Number.isFinite(s)).sort((a, b) => b - a);
  const best = sorted[0] ?? 0;
  const second = sorted[1];
  if (
    sorted.length >= 2 &&
    second !== undefined &&
    best < CONFIDENT_SCORE &&
    best - second >= LONE_SPIKE_GAP
  )
    return second;
  return best;
}

function rowFromLabels(
  confidence: Record<string, number>,
  labelToPerson: Record<string, string>,
): Record<string, number> {
  const byPerson = new Map<string, number[]>();
  for (const [label, score] of Object.entries(confidence)) {
    const person = labelToPerson[label];
    if (!person) continue;
    const list = byPerson.get(person) ?? [];
    list.push(score);
    byPerson.set(person, list);
  }
  const row: Record<string, number> = {};
  for (const [person, scores] of byPerson) row[person] = voiceprintPersonScore(scores);
  return row;
}

/**
 * Per diarization speaker and person, from pyannote's per-speaker `voiceprints[]` scores, once a
 * voiceprint or person that matches the room has been removed. `labelToPerson` maps the opaque
 * voiceprint label (`<speakerId>-<n>`) to the person (`speakerId`).
 */
export function buildScoreMatrix(
  voiceprints: IdentifyVoiceprintScores[],
  labelToPerson: Record<string, string>,
): ScoreMatrix {
  const matrix: ScoreMatrix = {};
  for (const v of resistHubVoiceprints(voiceprints))
    matrix[v.speaker] = rowFromLabels(v.confidence, labelToPerson);
  return resistHubPeople(matrix);
}

export interface ScoredSegment {
  start: number;
  end: number;
  /** Score (0–100) of each voiceprint label for this stretch of speech. */
  confidence?: Record<string, number>;
}

/**
 * Score matrix from segment-level identify output, independent of the speaker ids pyannote used in
 * that job: for each of our own speakers, the duration-weighted mean score of every voiceprint
 * label over the identify segments that overlap its speech, then the best label per person.
 */
export function buildScoreMatrixFromSegments(
  own: { speaker: string; start: number; end: number }[],
  scored: ScoredSegment[],
  labelToPerson: Record<string, string>,
): ScoreMatrix {
  const segs = scored.filter((s) => s.confidence).sort((a, b) => a.start - b.start);
  const sums = new Map<string, Map<string, { sum: number; sec: number }>>();
  let from = 0;
  for (const o of [...own].sort((a, b) => a.start - b.start)) {
    while (from < segs.length && segs[from]!.end <= o.start - 60) from++;
    for (let i = from; i < segs.length && segs[i]!.start < o.end; i++) {
      const s = segs[i]!;
      const sec = Math.min(s.end, o.end) - Math.max(s.start, o.start);
      if (sec <= 0) continue;
      const row = sums.get(o.speaker) ?? new Map<string, { sum: number; sec: number }>();
      sums.set(o.speaker, row);
      for (const [label, score] of Object.entries(s.confidence!)) {
        const cur = row.get(label) ?? { sum: 0, sec: 0 };
        row.set(label, { sum: cur.sum + score * sec, sec: cur.sec + sec });
      }
    }
  }
  const rows: IdentifyVoiceprintScores[] = [];
  for (const [speaker, row] of sums) {
    const confidence: Record<string, number> = {};
    for (const [label, { sum, sec }] of row) confidence[label] = Math.round((sum / sec) * 10) / 10;
    rows.push({ speaker, confidence });
  }
  return buildScoreMatrix(rows, labelToPerson);
}

export interface IdentifyOutputLike {
  /** The identify job's own (exclusive) diarization. */
  diarization: { speaker: string; start: number; end: number }[];
  /** Per speaker of that job: score of every voiceprint label (0-100). */
  voiceprints: IdentifyVoiceprintScores[];
}

/**
 * Score matrix from pyannote's own per-speaker aggregate scores. The identify job diarizes the
 * audio itself, so its speaker ids are mapped to ours by time overlap: our speaker takes the
 * identify speaker that covers most of its speech, provided that is at least `minShare` of it.
 * Returns the matrix plus the speakers that could not be mapped (use segment-level scores for those).
 */
export function buildSpeakerLevelMatrix(
  own: { speaker: string; start: number; end: number }[],
  output: IdentifyOutputLike,
  labelToPerson: Record<string, string>,
  minShare = 0.7,
): { matrix: ScoreMatrix; unmapped: string[] } {
  const rows = new Map(
    resistHubVoiceprints(output.voiceprints).map((v) => [v.speaker, v.confidence]),
  );
  const theirs = [...output.diarization].sort((a, b) => a.start - b.start);
  const overlap = new Map<string, Map<string, number>>();
  const ownTotal = new Map<string, number>();
  for (const o of own) {
    ownTotal.set(o.speaker, (ownTotal.get(o.speaker) ?? 0) + (o.end - o.start));
    for (const t of theirs) {
      if (t.start >= o.end) break;
      const sec = Math.min(t.end, o.end) - Math.max(t.start, o.start);
      if (sec <= 0) continue;
      const row = overlap.get(o.speaker) ?? new Map<string, number>();
      overlap.set(o.speaker, row);
      row.set(t.speaker, (row.get(t.speaker) ?? 0) + sec);
    }
  }
  const matrix: ScoreMatrix = {};
  const unmapped: string[] = [];
  for (const [speaker, total] of ownTotal) {
    const best = [...(overlap.get(speaker) ?? [])].sort((a, b) => b[1] - a[1])[0];
    const conf = best ? rows.get(best[0]) : undefined;
    if (!best || !conf || best[1] / total < minShare) {
      unmapped.push(speaker);
      continue;
    }
    matrix[speaker] = rowFromLabels(conf, labelToPerson);
  }
  return { matrix: resistHubPeople(matrix), unmapped };
}

export type ResolveStatus =
  'accepted' | 'below-threshold' | 'low-margin' | 'taken' | 'no-voiceprints';

export interface NameResolution {
  /** Person recognised, or null. */
  personId: string | null;
  /** Display name: the person's name, or `Unknown N` (numbered once per meeting). */
  name: string | null;
  /** Score of the best-paired person for this speaker (0 when there is none). */
  score: number;
  /** Score minus the best other person's score for this speaker. */
  margin: number;
  /** Best candidate even when rejected, for display ("closest: …"). */
  candidate: string | null;
  /** That candidate's person id and score, so a person can confirm a near miss. */
  candidateId: string | null;
  candidateScore: number;
  status: ResolveStatus;
}

export interface ResolveOptions {
  /** Accept a person only at or above this score. */
  minScore?: number;
  /** …and only when this far ahead of the runner-up. */
  minMargin?: number;
  /** Person id → display name. */
  names?: Record<string, string>;
}

/** Maximum-weight assignment of rows to columns (Hungarian algorithm; rows ≤ columns after padding). */
function assign(weights: number[][]): number[] {
  const n = weights.length;
  const m = Math.max(n, weights[0]?.length ?? 0);
  const cost = (i: number, j: number): number => -(weights[i]?.[j] ?? 0);
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else minv[j] = minv[j]! - delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0);
  }
  const result = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]! > 0) result[p[j]! - 1] = j - 1;
  return result;
}

/**
 * Decide who each pyannote speaker is. Pairs speakers with known people one-to-one so as to
 * maximise the total score; a pairing counts only if its score reaches `minScore` and leads the
 * speaker's best other candidate by `minMargin`. Everyone else is `Unknown N`, numbered in the
 * order given by `speakers` (first appearance in the meeting).
 */
export function resolveNames(
  speakers: string[],
  matrix: ScoreMatrix,
  { minScore = 60, minMargin = 10, names = {} }: ResolveOptions = {},
): Record<string, NameResolution> {
  const people = [...new Set(Object.values(matrix).flatMap((row) => Object.keys(row)))];
  const out: Record<string, NameResolution> = {};
  const pairing = people.length
    ? assign(speakers.map((s) => people.map((p) => matrix[s]?.[p] ?? 0)))
    : speakers.map(() => -1);

  const claimed = new Set(
    pairing.filter((j) => j >= 0 && j < people.length).map((j) => people[j]!),
  );
  let unknown = 0;
  speakers.forEach((s, i) => {
    const row = matrix[s] ?? {};
    const ranked = Object.entries(row).sort((a, b) => b[1] - a[1]);
    const best = ranked[0];
    const paired = pairing[i]! >= 0 && pairing[i]! < people.length ? people[pairing[i]!]! : null;
    const score = paired ? (row[paired] ?? 0) : 0;
    const others = ranked.filter(([p]) => p !== paired).map(([, sc]) => sc);
    const margin = paired ? Math.round((score - (others[0] ?? 0)) * 10) / 10 : 0;
    let status: ResolveStatus;
    if (!people.length) status = 'no-voiceprints';
    else if (!paired || score < minScore)
      // Its best candidate is a real match that another voice was paired with.
      status =
        best && best[1] >= minScore && best[0] !== paired && claimed.has(best[0])
          ? 'taken'
          : 'below-threshold';
    else if (best && best[0] !== paired && best[1] > score) status = 'taken';
    else if (margin < minMargin) status = 'low-margin';
    else status = 'accepted';
    const accepted = status === 'accepted' && paired !== null;
    out[s] = {
      personId: accepted ? paired : null,
      name: accepted ? (names[paired!] ?? paired) : `Unknown ${++unknown}`,
      score,
      margin,
      candidate: best ? (names[best[0]] ?? best[0]) : null,
      candidateId: best ? best[0] : null,
      candidateScore: best ? best[1] : 0,
      status,
    };
  });
  return out;
}

export interface VoiceprintCandidate {
  personId: string;
  quality: number | null;
}

/**
 * At most `max` voiceprints for one identify request (pyannote takes 50), spread over people:
 * every person's best voiceprint first, then every person's second best, and so on. People with
 * better voiceprints come first within a round.
 */
export function pickVoiceprints<T extends VoiceprintCandidate>(items: T[], max = 50): T[] {
  const byPerson = new Map<string, T[]>();
  for (const it of items) byPerson.set(it.personId, [...(byPerson.get(it.personId) ?? []), it]);
  const queues = [...byPerson.values()].map((q) =>
    [...q].sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0)),
  );
  queues.sort((a, b) => (b[0]?.quality ?? 0) - (a[0]?.quality ?? 0));
  const out: T[] = [];
  for (let round = 0; out.length < max; round++) {
    let added = false;
    for (const q of queues) {
      const item = q[round];
      if (item && out.length < max) {
        out.push(item);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}
