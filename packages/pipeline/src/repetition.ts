import { tokenize } from './text.js';

export interface RepetitionOptions {
  /** Longest phrase (in tokens) checked for back-to-back repetition. */
  maxPhraseTokens?: number;
}

/**
 * How many consecutive times a phrase of `n` tokens must repeat before it counts as a loop.
 * Single words repeat legitimately ("haan haan haan", "no no no"), so short phrases need many
 * more repetitions than long ones.
 */
function threshold(n: number): number {
  if (n === 1) return 20;
  if (n === 2) return 10;
  return 6;
}

/**
 * Detect the engine repetition bug: the model loops one phrase for dozens of lines until it hits
 * the output limit. Checks for any phrase of 1..maxPhraseTokens tokens repeated back-to-back more
 * than its threshold, and for long outputs whose 4-grams are overwhelmingly duplicates.
 */
export function looksRepetitive(
  text: string,
  { maxPhraseTokens = 12 }: RepetitionOptions = {},
): boolean {
  const tokens = tokenize(text);
  const len = tokens.length;
  if (len < 12) return false;

  for (let n = 1; n <= maxPhraseTokens; n++) {
    const need = threshold(n);
    if (n * need > len) break;
    for (let i = 0; i + n * need <= len; i++) {
      let reps = 1;
      let j = i + n;
      while (j + n <= len) {
        let same = true;
        for (let k = 0; k < n; k++) {
          if (tokens[i + k] !== tokens[j + k]) {
            same = false;
            break;
          }
        }
        if (!same) break;
        reps++;
        j += n;
      }
      if (reps >= need) return true;
      // skip past the run we just measured
      if (reps > 1) i += n * (reps - 1);
    }
  }

  if (len >= 200) {
    const grams = new Set<string>();
    for (let i = 0; i + 4 <= len; i++) grams.add(tokens.slice(i, i + 4).join(' '));
    if (grams.size / (len - 3) < 0.25) return true;
  }
  return false;
}
