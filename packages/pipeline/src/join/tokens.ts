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

/** Devanagari consonants (after foldWord: Gujarati is already Devanagari) to a coarse Latin class. */
const DEV_CONSONANT: Record<string, string> = {
  क: 'k',
  ख: 'k',
  ग: 'k',
  घ: 'k',
  ङ: 'n',
  च: 'j',
  छ: 'j',
  ज: 'j',
  झ: 'j',
  ञ: 'n',
  ट: 't',
  ठ: 't',
  ड: 't',
  ढ: 't',
  ण: 'n',
  त: 't',
  थ: 't',
  द: 't',
  ध: 't',
  न: 'n',
  प: 'p',
  फ: 'p',
  ब: 'p',
  भ: 'p',
  म: 'm',
  र: 'r',
  ल: 'l',
  व: 'v',
  श: 's',
  ष: 's',
  स: 's',
};

/**
 * A coarse consonant skeleton that the same spoken word has in Devanagari, Gujarati and Latin
 * spelling (प्रिंट, print → "prnt"; डिजिटल, digital → "tjtl" / "tktl", one edit apart). Voicing and
 * aspiration are folded, vowels and h/y dropped. Gemini writes English words in Devanagari where
 * Deepgram writes them in Latin, which plain folding cannot match.
 */
export function phoneticSkeleton(word: string): string {
  const s = foldWord(word);
  let out = '';
  const push = (c: string): void => {
    if (out[out.length - 1] !== c) out += c;
  };
  const latin = s
    .replace(/sh/g, 's')
    .replace(/ch/g, 'j')
    .replace(/[tdbkgp]h/g, (m) => m[0]!)
    .replace(/ck/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k');
  for (const ch of Array.from(latin)) {
    const dev = DEV_CONSONANT[ch];
    if (dev) push(dev);
    else if (ch === 'ं' || ch === 'ँ') push('n');
    else if (/[0-9]/.test(ch)) push(ch);
    else if (/[a-z]/.test(ch)) {
      const m = (
        {
          b: 'p',
          d: 't',
          g: 'k',
          f: 'p',
          q: 'k',
          w: 'v',
          z: 'j',
          x: 'ks',
          k: 'k',
          j: 'j',
          l: 'l',
          m: 'm',
          n: 'n',
          p: 'p',
          r: 'r',
          s: 's',
          t: 't',
          v: 'v',
        } as Record<string, string>
      )[ch];
      if (m) for (const c of m) push(c);
    }
  }
  return out;
}

/** Alignment key: the folded word and its skeleton, joined by "|". */
export function wordKey(word: string): string {
  return `${foldWord(word)}|${phoneticSkeleton(word)}`;
}

/** Match two `wordKey`s: equal or near-equal folded words, or the same skeleton (3+ consonants). */
export function keysMatch(a: string, b: string): boolean {
  const [fa = '', sa = ''] = a.split('|');
  const [fb = '', sb = ''] = b.split('|');
  if (wordsMatch(fa, fb)) return true;
  // two-consonant skeletons (टीवी / TV) only when one side is Devanagari and the other Latin
  if (sa.length === 2 && sa === sb) return /[ऀ-ॿ]/.test(fa) !== /[ऀ-ॿ]/.test(fb);
  if (sa.length < 3 || sb.length < 3) return false;
  return sa === sb || (Math.min(sa.length, sb.length) >= 4 && withinOneEdit(sa, sb));
}
