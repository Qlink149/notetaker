/**
 * What of a pyannote job output is worth keeping in MongoDB. The top-level `confidence` is a
 * frame-by-frame curve (precision-2 only): about 1.1 MB for 34 minutes, half of everything a meeting
 * stores, and nothing reads it (the app uses the per-segment `confidence` maps and the voiceprint
 * scores, which are kept). Everything else is stored as received.
 */
export function trimOutput<T>(output: T): T {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  if (!('confidence' in output)) return output;
  const { confidence: _frameCurve, ...rest } = output as Record<string, unknown>;
  return rest as T;
}
