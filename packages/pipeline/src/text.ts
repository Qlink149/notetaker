/** Text helpers shared by seam merging, speaker linking and repetition detection. */

/** Lower-cased word tokens with punctuation removed. Keeps letters and digits in any script. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Token-set Jaccard similarity in [0, 1]. Two empty texts are not similar. */
export function jaccard(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Seconds → `mm:ss` (or `h:mm:ss` past an hour). */
export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Overlap similarity for texts of very different length: the share of the shorter text's distinct
 * tokens found in the longer one. Falls back to Jaccard when the shorter text has fewer than
 * `minTokens` tokens, so fillers like "haan ji" never match by containment.
 */
export function containment(a: string, b: string, minTokens = 4): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  if (small.size < minTokens) return jaccard(a, b);
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  return inter / small.size;
}
