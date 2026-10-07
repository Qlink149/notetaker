import type { Turn } from '@meetingid/shared';

/** Any character from the Indic blocks (Devanagari U+0900 through Sinhala U+0DFF). */
const INDIC = /[ऀ-෿]/;
const INDIC_RUN = /[ऀ-෿]+/g;

export const hasIndic = (text: string): boolean => INDIC.test(text);

// Devanagari → Latin in the spelling the engines use for text_roman (no diacritics, "aa"/"ee").
// Gujarati (U+0A80–U+0AFF) mirrors the Devanagari block at an offset of 0x180 and is mapped onto it.
const CONSONANTS: Record<string, string> = {
  क: 'k',
  ख: 'kh',
  ग: 'g',
  घ: 'gh',
  ङ: 'n',
  च: 'ch',
  छ: 'chh',
  ज: 'j',
  झ: 'jh',
  ञ: 'n',
  ट: 't',
  ठ: 'th',
  ड: 'd',
  ढ: 'dh',
  ण: 'n',
  त: 't',
  थ: 'th',
  द: 'd',
  ध: 'dh',
  न: 'n',
  ऩ: 'n',
  प: 'p',
  फ: 'ph',
  ब: 'b',
  भ: 'bh',
  म: 'm',
  य: 'y',
  र: 'r',
  ऱ: 'r',
  ल: 'l',
  ळ: 'l',
  ऴ: 'l',
  व: 'v',
  श: 'sh',
  ष: 'sh',
  स: 's',
  ह: 'h',
  क़: 'q',
  ख़: 'kh',
  ग़: 'g',
  ज़: 'z',
  ड़: 'd',
  ढ़: 'dh',
  फ़: 'f',
  य़: 'y',
};
const VOWELS: Record<string, string> = {
  ऄ: 'a',
  अ: 'a',
  आ: 'aa',
  इ: 'i',
  ई: 'ee',
  उ: 'u',
  ऊ: 'oo',
  ऋ: 'ri',
  ऍ: 'e',
  ऎ: 'e',
  ए: 'e',
  ऐ: 'ai',
  ऑ: 'o',
  ऒ: 'o',
  ओ: 'o',
  औ: 'au',
};
const MATRAS: Record<string, string> = {
  'ा': 'aa',
  'ि': 'i',
  'ी': 'ee',
  'ु': 'u',
  'ू': 'oo',
  'ृ': 'ri',
  'ॄ': 'ri',
  'ॅ': 'e',
  'ॆ': 'e',
  'े': 'e',
  'ै': 'ai',
  'ॉ': 'o',
  'ॊ': 'o',
  'ो': 'o',
  'ौ': 'au',
};
const SIGNS: Record<string, string> = { 'ँ': 'n', 'ं': 'n', 'ः': 'h', ॐ: 'om', '।': '.', '॥': '.' };
const VIRAMA = '्';
const NUKTA = '़';
/** Consonant + a separate nukta sign (NFC keeps them apart): k→q, j→z, ph→f. */
const NUKTA_FORMS: [string, string][] = [
  ['ph', 'f'],
  ['k', 'q'],
  ['j', 'z'],
];

const toDevanagari = (ch: string): string => {
  const cp = ch.codePointAt(0)!;
  return cp >= 0x0a80 && cp <= 0x0aff ? String.fromCodePoint(cp - 0x180) : ch;
};

/**
 * Romanise one run of Devanagari or Gujarati letters. Consonants carry an inherent "a" unless a
 * vowel sign or virama follows; word-final "ee"/"aa" are written "i"/"a"; a word-final inherent "a" is dropped after the first syllable
 * (Hindi/Gujarati schwa deletion: "काम" → "kaam"). Medial schwas are kept ("दूसरी" →
 * "doosari"), so the result is readable rather than exact. Returns null for other Indic scripts.
 */
export function transliterateIndic(run: string): string | null {
  const chars = [...run.normalize('NFC')].map(toDevanagari);
  if (chars.some((c) => c < 'ऀ' || c > 'ॿ')) return null;
  let out = '';
  let pending = false; // a consonant waiting for its vowel
  let syllables = 0;
  for (const c of chars) {
    if (c === NUKTA) {
      const form = NUKTA_FORMS.find(([from]) => out.endsWith(from));
      if (pending && form) out = out.slice(0, -form[0].length) + form[1];
      continue;
    }
    if (CONSONANTS[c]) {
      if (pending) out += 'a';
      out += CONSONANTS[c];
      pending = true;
      syllables++;
    } else if (MATRAS[c]) {
      out += MATRAS[c];
      pending = false;
    } else if (c === VIRAMA) {
      pending = false;
    } else if (VOWELS[c]) {
      if (pending) out += 'a';
      out += VOWELS[c];
      pending = false;
      syllables++;
    } else if (SIGNS[c]) {
      if (pending && c !== '।' && c !== '॥') out += 'a';
      out += SIGNS[c];
      pending = false;
    } else if (c >= '०' && c <= '९') {
      out += String(c.codePointAt(0)! - 0x0966);
    }
  }
  if (pending && syllables === 1) out += 'a';
  // Word-final long vowels are written short in romanised Hindi/Gujarati ("raha", "zaroori").
  return out.length > 2 ? out.replace(/ee$/, 'i').replace(/aa$/, 'a') : out;
}

/**
 * Post-check of `textRoman`: the engines sometimes leave a Devanagari or Gujarati word in the
 * roman text. Such words are transliterated in place and the turn is marked
 * `romanFix: 'transliterated'`; if a script without a mapping remains, it is marked `'unrepaired'`.
 */
export function repairRomanLeaks(turns: Turn[]): Turn[] {
  return turns.map((t) => {
    if (!hasIndic(t.textRoman)) return t;
    const textRoman = t.textRoman
      .replace(INDIC_RUN, (run) => transliterateIndic(run) ?? run)
      .replace(/\s+/g, ' ')
      .trim();
    return {
      ...t,
      textRoman,
      romanFix: hasIndic(textRoman) ? ('unrepaired' as const) : ('transliterated' as const),
    };
  });
}
