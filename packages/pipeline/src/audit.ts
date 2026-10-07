/** Small deterministic generator (mulberry32) seeded from a string, so a re-seeded audit is stable. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * Pick `n` lines, a third of them short (under `shortSec`), the rest longer. If one group is too
 * small the other fills the gap, so the result has min(n, available) items.
 */
export function stratifiedSample<T extends { start: number; end: number }>(
  items: T[],
  n: number,
  rng: () => number,
  { shortSec = 3, shortShare = 1 / 3 }: { shortSec?: number; shortShare?: number } = {},
): T[] {
  const short = shuffled(
    items.filter((i) => i.end - i.start < shortSec),
    rng,
  );
  const long = shuffled(
    items.filter((i) => i.end - i.start >= shortSec),
    rng,
  );
  const wantShort = Math.min(short.length, Math.round(n * shortShare));
  const wantLong = Math.min(long.length, n - wantShort);
  const fillShort = Math.min(short.length, n - wantLong);
  return [...short.slice(0, fillShort), ...long.slice(0, wantLong)];
}

export interface AuditAnswer {
  method: string;
  speaker: 'right' | 'wrong' | 'unsure' | null;
  text: 'match' | 'partly' | 'no' | null;
}

export interface AuditTally {
  method: string;
  /** Items shown / items with a speaker answer. */
  items: number;
  answered: number;
  right: number;
  wrong: number;
  unsure: number;
  /** right / answered (can't-tell counts against the method). */
  speakerCorrectRate: number | null;
  /** right / (right + wrong): leaves out the lines the auditor could not judge. */
  speakerCorrectRateDecided: number | null;
  /** wrong / answered: lines under the wrong name. */
  wrongNameRate: number | null;
  textAnswered: number;
  textMatch: number;
  textPartly: number;
  textNo: number;
  textMatchRate: number | null;
}

const rate = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 1000) / 1000 : null;

export function tallyAudit(answers: AuditAnswer[]): AuditTally[] {
  const methods = [...new Set(answers.map((a) => a.method))].sort();
  return methods.map((method) => {
    const mine = answers.filter((a) => a.method === method);
    const spoke = mine.filter((a) => a.speaker);
    const right = spoke.filter((a) => a.speaker === 'right').length;
    const wrong = spoke.filter((a) => a.speaker === 'wrong').length;
    const unsure = spoke.filter((a) => a.speaker === 'unsure').length;
    const txt = mine.filter((a) => a.text);
    const textMatch = txt.filter((a) => a.text === 'match').length;
    return {
      method,
      items: mine.length,
      answered: spoke.length,
      right,
      wrong,
      unsure,
      speakerCorrectRate: rate(right, spoke.length),
      speakerCorrectRateDecided: rate(right, right + wrong),
      wrongNameRate: rate(wrong, spoke.length),
      textAnswered: txt.length,
      textMatch,
      textPartly: txt.filter((a) => a.text === 'partly').length,
      textNo: txt.filter((a) => a.text === 'no').length,
      textMatchRate: rate(textMatch, txt.length),
    };
  });
}
