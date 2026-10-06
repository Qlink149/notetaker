import type { Turn, TurnLang } from '@meetingid/shared';

/** Raw turn as an engine returns it, in seconds relative to the chunk file. */
export interface RawTurn {
  speaker: string;
  start: number;
  end: number;
  text_native: string;
  text_roman: string;
  lang: TurnLang;
}

/** Rough speaking rate used to give zero-length turns a plausible end time. */
const SEC_PER_WORD = 0.4;

/**
 * Detect timestamps written as minutes.seconds (`2.35` meaning 2 min 35 s) instead of seconds:
 * every value fits within the chunk's length in minutes, no fractional part reaches .60, and the
 * chunk is long enough that real second offsets would be far larger.
 */
export function looksLikeMinuteSeconds(turns: RawTurn[], chunkDurationSec: number): boolean {
  if (turns.length < 3 || chunkDurationSec < 180) return false;
  const values = turns.flatMap((t) => [t.start, t.end]).filter((v) => Number.isFinite(v));
  const max = Math.max(...values);
  if (max > chunkDurationSec / 60 + 1) return false;
  return values.every((v) => {
    const frac = Math.round((v - Math.floor(v)) * 100);
    return frac < 60;
  });
}

const minuteSecondsToSec = (v: number): number => {
  const m = Math.floor(v);
  return m * 60 + Math.round((v - m) * 100);
};

/**
 * Clean one chunk's engine turns and re-base them to absolute meeting time:
 * drop empty text, repair minute.second timestamps, clamp into the chunk, force non-decreasing
 * starts and a positive length, then add `offsetSec`.
 */
export function normalizeChunkTurns(
  raw: RawTurn[],
  chunkDurationSec: number,
  offsetSec: number,
): Turn[] {
  const fixMs = looksLikeMinuteSeconds(raw, chunkDurationSec);
  const clamp = (v: number): number =>
    Math.min(Math.max(Number.isFinite(v) ? v : 0, 0), chunkDurationSec);

  const kept = raw
    .map((t) => ({
      ...t,
      start: clamp(fixMs ? minuteSecondsToSec(t.start) : t.start),
      end: clamp(fixMs ? minuteSecondsToSec(t.end) : t.end),
      text_native: (t.text_native ?? '').trim(),
      text_roman: (t.text_roman ?? '').trim(),
    }))
    .filter((t) => t.text_native || t.text_roman);

  const out: Turn[] = [];
  let lastStart = 0;
  for (let i = 0; i < kept.length; i++) {
    const t = kept[i]!;
    const start = Math.max(t.start, lastStart);
    let end = Math.max(t.end, start);
    if (end - start < 0.05) {
      const words = (t.text_roman || t.text_native).split(/\s+/).length;
      const nextStart = kept[i + 1]?.start ?? chunkDurationSec;
      end = Math.min(
        chunkDurationSec,
        Math.max(start + 0.3, Math.min(start + words * SEC_PER_WORD, nextStart)),
      );
    }
    lastStart = start;
    out.push({
      speaker: t.speaker?.trim() || 'S?',
      start: round3(start + offsetSec),
      end: round3(end + offsetSec),
      textNative: t.text_native || t.text_roman,
      textRoman: t.text_roman || t.text_native,
      lang: t.lang,
    });
  }
  return out;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
