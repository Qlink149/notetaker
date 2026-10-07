import type { Line, Turn } from '@meetingid/shared';

export interface LineOptions {
  /** No rendered line may be longer than this. */
  maxLineSec?: number;
  /** Consecutive turns of one speaker merge only when the gap between them is below this. */
  pauseSec?: number;
}

const SENTENCE_END = /[.!?।॥]$/;

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Split `tokens` into `n` runs of similar size, preferring cuts after sentence punctuation. */
function splitTokens(tokens: string[], n: number): string[][] {
  if (n <= 1 || tokens.length <= 1) return [tokens];
  const parts: string[][] = [];
  let from = 0;
  for (let k = 1; k < n; k++) {
    const remainingParts = n - k + 1;
    const target = from + Math.round((tokens.length - from) / remainingParts);
    const slack = Math.max(1, Math.floor((tokens.length / n) * 0.3));
    let cut = target;
    for (let d = 0; d <= slack; d++) {
      const after = target + d;
      const before = target - d;
      if (after < tokens.length && SENTENCE_END.test(tokens[after - 1] ?? '')) {
        cut = after;
        break;
      }
      if (before > from && SENTENCE_END.test(tokens[before - 1] ?? '')) {
        cut = before;
        break;
      }
    }
    cut = Math.min(Math.max(cut, from + 1), tokens.length - (n - k));
    parts.push(tokens.slice(from, cut));
    from = cut;
  }
  parts.push(tokens.slice(from));
  return parts;
}

/**
 * Split one turn longer than `maxLineSec` into pieces of at most that length.
 * Times are interpolated by word share, since engine timestamps are utterance-level only.
 */
export function splitLongTurn(turn: Turn, maxLineSec: number): Turn[] {
  const duration = turn.end - turn.start;
  if (duration <= maxLineSec) return [turn];
  const n = Math.ceil(duration / maxLineSec);
  const roman = splitTokens(words(turn.textRoman), n);
  const native = splitTokens(words(turn.textNative), n);
  const pieces = Math.max(roman.length, native.length);
  const total = Math.max(1, words(turn.textRoman || turn.textNative).length);
  const basis = turn.textRoman ? roman : native;

  const out: Turn[] = [];
  let consumed = 0;
  for (let i = 0; i < pieces; i++) {
    const count = basis[i]?.length ?? 0;
    const start = turn.start + (duration * consumed) / total;
    consumed += count;
    const end = i === pieces - 1 ? turn.end : turn.start + (duration * consumed) / total;
    out.push({
      ...turn,
      // interpolated by word share inside the engine's turn
      timeEstimated: true,
      start,
      end: Math.min(end, start + maxLineSec),
      textRoman: (roman[i] ?? []).join(' '),
      textNative: (native[i] ?? []).join(' '),
    });
  }
  return out.filter((t) => t.textRoman || t.textNative);
}

/**
 * Turn engine turns into display lines. Consecutive turns of the same speaker merge only when the
 * pause between them is under `pauseSec` and the merged line stays within `maxLineSec`; any
 * single turn longer than `maxLineSec` is split first.
 */
export function turnsToLines(
  turns: Turn[],
  speakerMap: Record<string, string> = {},
  { maxLineSec = 45, pauseSec = 1.2 }: LineOptions = {},
): Line[] {
  const sorted = [...turns].sort((a, b) => a.start - b.start);
  const lines: Line[] = [];
  let lastSpeaker: string | null = null;
  for (const turn of sorted.flatMap((t) => splitLongTurn(t, maxLineSec))) {
    const speakerName = speakerMap[turn.speaker] ?? turn.speaker;
    const last = lines[lines.length - 1];
    const canMerge =
      last !== undefined &&
      lastSpeaker === turn.speaker &&
      turn.start - last.end < pauseSec &&
      Math.max(last.end, turn.end) - last.start <= maxLineSec;
    if (canMerge) {
      if (turn.timeEstimated) last.timeEstimated = true;
      if (turn.timeScaled) last.timeScaled = true;
      if (turn.romanFix && last.romanFix !== 'unrepaired') last.romanFix = turn.romanFix;
      last.end = Math.max(last.end, turn.end);
      last.textRoman = [last.textRoman, turn.textRoman].filter(Boolean).join(' ');
      last.textNative = [last.textNative, turn.textNative].filter(Boolean).join(' ');
    } else {
      lines.push({
        speakerName,
        start: turn.start,
        end: turn.end,
        textRoman: turn.textRoman,
        textNative: turn.textNative,
        ...(turn.timeEstimated ? { timeEstimated: true } : {}),
        ...(turn.timeScaled ? { timeScaled: true } : {}),
        ...(turn.romanFix ? { romanFix: turn.romanFix } : {}),
      });
    }
    lastSpeaker = turn.speaker;
  }
  return lines;
}
