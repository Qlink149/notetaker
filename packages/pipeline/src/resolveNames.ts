/** Score of each person for each pyannote speaker: matrix[speaker][personId] (0–100). */
export type ScoreMatrix = Record<string, Record<string, number>>;

export interface IdentifyVoiceprintScores {
  speaker: string;
  confidence: Record<string, number>;
}

/**
 * Per diarization speaker and person, the best score among that person's voiceprints.
 * `labelToPerson` maps the opaque voiceprint label sent to pyannote (`<speakerId>-<n>`) to the
 * person (`speakerId`). Uses pyannote's per-speaker `voiceprints[]` scores.
 */
export function buildScoreMatrix(
  voiceprints: IdentifyVoiceprintScores[],
  labelToPerson: Record<string, string>,
): ScoreMatrix {
  const matrix: ScoreMatrix = {};
  for (const v of voiceprints) {
    const row = (matrix[v.speaker] ??= {});
    for (const [label, score] of Object.entries(v.confidence ?? {})) {
      const person = labelToPerson[label];
      if (!person) continue;
      row[person] = Math.max(row[person] ?? -Infinity, score);
    }
  }
  return matrix;
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
      status,
    };
  });
  return out;
}
