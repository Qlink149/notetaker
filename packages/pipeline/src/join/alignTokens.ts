import { wordsMatch } from './tokens.js';

const MATCH = 3;
const MISMATCH = -1;
const GAP = -1;

/**
 * Semi-global alignment (Needleman–Wunsch) of two folded word sequences that allows insertions and
 * deletions: every word of `a` is placed, but words of `b` before the first and after the last
 * match are free, so a longer `b` window never drags matches towards its far end.
 * Returns, for every word of `a`, the index of the word in `b` it matched, or -1.
 * Substitutions count as unmatched so that only agreeing words anchor times and speakers.
 * Memory is |a|·|b| bytes, so callers align in blocks of about a thousand words.
 */
export function alignTokens(a: string[], b: string[]): number[] {
  const n = a.length;
  const m = b.length;
  const out = new Array<number>(n).fill(-1);
  if (!n || !m) return out;
  const w = m + 1;
  const trace = new Uint8Array((n + 1) * w); // 1 diagonal, 2 up (gap in b), 3 left (gap in a)
  let prev = new Int32Array(w);
  let cur = new Int32Array(w);
  // Row 0: skipping leading words of b is free.
  for (let j = 1; j <= m; j++) trace[j] = 3;
  for (let i = 1; i <= n; i++) {
    cur[0] = i * GAP;
    trace[i * w] = 2;
    for (let j = 1; j <= m; j++) {
      const diag = prev[j - 1]! + (wordsMatch(a[i - 1]!, b[j - 1]!) ? MATCH : MISMATCH);
      const up = prev[j]! + GAP;
      const left = cur[j - 1]! + GAP;
      if (diag >= up && diag >= left) {
        cur[j] = diag;
        trace[i * w + j] = 1;
      } else if (up >= left) {
        cur[j] = up;
        trace[i * w + j] = 2;
      } else {
        cur[j] = left;
        trace[i * w + j] = 3;
      }
    }
    [prev, cur] = [cur, prev];
  }
  // Trailing words of b are free: start from the best cell of the last row.
  let i = n;
  let j = 0;
  for (let c = 1; c <= m; c++) if (prev[c]! > prev[j]!) j = c;
  while (i > 0 && j > 0) {
    const t = trace[i * w + j];
    if (t === 1) {
      if (wordsMatch(a[i - 1]!, b[j - 1]!)) out[i - 1] = j - 1;
      i--;
      j--;
    } else if (t === 2) i--;
    else j--;
  }
  return out;
}
