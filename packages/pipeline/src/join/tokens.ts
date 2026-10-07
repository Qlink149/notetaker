const ZERO_WIDTH = new RegExp('[\u200b-\u200d\u2060\ufeff]', 'g');
const PUNCT = /[\p{P}\p{S}]/gu;

/**
 * Comparison form of a word, tolerant of the differences between two engines' spellings:
 * case, punctuation, Gujarati vs Devanagari letters (the blocks are parallel), digits in any
 * script, nukta, chandrabindu vs anusvara, and short vs long i/u.
 */
export function foldWord(word: string): string {
  let s = word.normalize('NFC').toLowerCase().replace(ZERO_WIDTH, '').replace(PUNCT, '');
  s = Array.from(s)
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      return c >= 0x0a81 && c <= 0x0aff ? String.fromCodePoint(c - 0x180) : ch;
    })
    .join('');
  return s
    .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966))
    .replace(/़/g, '')
    .replace(/ँ/g, 'ं')
    .replace(/ी/g, 'ि')
    .replace(/ू/g, 'ु')
    .replace(/ई/g, 'इ')
    .replace(/ऊ/g, 'उ');
}

/** Whitespace-separated words of a transcript line. */
export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length || i === b.length) return true; // differ by a trailing character at most
  const restA = a.slice(i + 1);
  const restB = b.slice(i + 1);
  if (a.length === b.length) return restA === restB; // substitution
  return a.length > b.length ? restA === b.slice(i) : a.slice(i) === restB; // insertion / deletion
}

/** Folded forms equal, or within one edit for words of 4+ characters. */
export function wordsMatch(foldedA: string, foldedB: string): boolean {
  if (!foldedA || !foldedB) return false;
  if (foldedA === foldedB) return true;
  return Math.min(foldedA.length, foldedB.length) >= 4 && withinOneEdit(foldedA, foldedB);
}
