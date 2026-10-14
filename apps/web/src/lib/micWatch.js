/** Level below which the microphone is treated as hearing nothing (dBFS of the signal's RMS). */
export const SILENCE_DB = -60;
/** How long it must stay that quiet before the person is warned. */
export const SILENCE_MS = 10_000;

/** RMS level of a block of samples (-1..1) in dBFS; -100 for an empty block. */
export function rmsDb(samples) {
  if (!samples?.length) return -100;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.max(-100, 20 * Math.log10(Math.sqrt(sum / samples.length) || 1e-5));
}

/**
 * Tracks how long the microphone has been silent. `update(db, nowMs)` returns true once the level has
 * stayed below SILENCE_DB for SILENCE_MS, and false again as soon as sound returns.
 */
export function createSilenceWatch({ thresholdDb = SILENCE_DB, afterMs = SILENCE_MS } = {}) {
  let since = null;
  return {
    update(db, nowMs) {
      if (db >= thresholdDb) {
        since = null;
        return false;
      }
      if (since === null) since = nowMs;
      return nowMs - since >= afterMs;
    },
    reset() {
      since = null;
    },
  };
}
