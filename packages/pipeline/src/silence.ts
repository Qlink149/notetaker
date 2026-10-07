export interface SilenceThresholdOptions {
  /** Threshold used for clean recordings, and when the noise floor is unknown. */
  baseDb?: number;
  /** How far above the noise floor counts as speech. */
  marginDb?: number;
  /** Never less sensitive than this. */
  maxDb?: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Silence threshold for ffmpeg `silencedetect`: the fixed −35 dB, raised to `noise floor + 10 dB`
 * when the background is louder than that allows (capped at −25 dB). The noise floor is the
 * 10th-percentile loudness of 0.5 s windows. A fixed −35 dB found no silence at all in a recording
 * whose background sat at −40 dB; mean-relative rules made clean recordings worse (DECISIONS #14).
 */
export function silenceThresholdDb(
  noiseFloorDb: number | null | undefined,
  { baseDb = -35, marginDb = 10, maxDb = -25 }: SilenceThresholdOptions = {},
): number {
  if (noiseFloorDb === null || noiseFloorDb === undefined || !Number.isFinite(noiseFloorDb)) {
    return baseDb;
  }
  return round1(Math.min(maxDb, Math.max(baseDb, noiseFloorDb + marginDb)));
}

/** Value at quantile `q` (0..1) of `values`; null for an empty list. */
export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(Math.min(1, Math.max(0, q)) * (sorted.length - 1))]!;
}
