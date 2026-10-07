/** Name folded for comparison: case, accents, spaces, dots and hyphens ignored. */
export function foldName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\s.\-_,]+/g, '');
}

function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      rowMin = Math.min(rowMin, cur[j]!);
    }
    if (rowMin > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Existing names that are probably the same person as `name`: equal after folding case, spacing
 * and punctuation, or within `maxEdits` edits (default 2) when both are at least 5 characters.
 */
export function similarNames(name: string, existing: string[], maxEdits = 2): string[] {
  const f = foldName(name);
  if (!f) return [];
  return existing.filter((e) => {
    const g = foldName(e);
    if (!g) return false;
    if (f === g) return true;
    return Math.min(f.length, g.length) >= 5 && editDistance(f, g, maxEdits) <= maxEdits;
  });
}
