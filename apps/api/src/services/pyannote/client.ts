import { requireEnv } from '../../config/env.js';

// Ported from legacy/base44/shared/pyannote.ts and the pyannote helpers in pipeline.ts.
// Phase 1 only uses `createVoiceprint` (speaker enrolment); identify/diarize are kept compiling
// for Phase 2's VoiceprintResolver.

const BASE = 'https://api.pyannote.ai/v1';

/** pyannote ignores `matching.threshold`; measured scores were 83-89 for enrolled speakers, 16-36 otherwise. */
export const MATCH_CONFIDENCE_MIN = 50;

export function pyannoteHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${requireEnv('PYANNOTEAI_API_KEY')}`,
    'Content-Type': 'application/json',
  };
}

interface Job<T> {
  status: string;
  output?: T;
}

export async function checkPyannoteJob<T = unknown>(
  jobId: string,
): Promise<{ done: boolean; output: T | null }> {
  const res = await fetch(`${BASE}/jobs/${jobId}`, { headers: pyannoteHeaders() });
  if (!res.ok) throw new Error(`pyannote job check failed: ${res.status}`);
  const job = (await res.json()) as Job<T>;
  if (job.status === 'succeeded' || job.status === 'done')
    return { done: true, output: job.output ?? null };
  if (job.status === 'failed') throw new Error(`pyannote job failed: ${JSON.stringify(job)}`);
  return { done: false, output: null };
}

export async function pollPyannoteJob<T = unknown>(
  jobId: string,
  maxAttempts = 50,
  intervalMs = 3000,
): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    const { done, output } = await checkPyannoteJob<T>(jobId);
    if (done) return output as T;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('pyannote job timed out');
}

/** Create a voiceprint from a 3-30 s clip URL; returns the voiceprint string. */
export async function createVoiceprint(url: string): Promise<string> {
  const res = await fetch(`${BASE}/voiceprint`, {
    method: 'POST',
    headers: pyannoteHeaders(),
    body: JSON.stringify({ url, model: 'precision-2' }),
  });
  if (!res.ok) throw new Error(`pyannote voiceprint create failed: ${await res.text()}`);
  const { jobId } = (await res.json()) as { jobId: string };
  const output = await pollPyannoteJob<{ voiceprint?: string }>(jobId);
  if (!output?.voiceprint) throw new Error('No voiceprint returned');
  return output.voiceprint;
}

export interface VoiceprintRef {
  label: string;
  voiceprint: string;
}

export async function submitIdentify(
  audioUrl: string,
  voiceprints: VoiceprintRef[],
): Promise<string | null> {
  const valid = voiceprints.filter((v) => v.voiceprint).slice(0, 10);
  if (!valid.length) return null;
  const res = await fetch(`${BASE}/identify`, {
    method: 'POST',
    headers: pyannoteHeaders(),
    body: JSON.stringify({
      url: audioUrl,
      voiceprints: valid,
      matching: { threshold: MATCH_CONFIDENCE_MIN, exclusive: true },
      confidence: true,
      turnLevelConfidence: true,
    }),
  });
  if (!res.ok) throw new Error(`pyannote identify submit failed: ${await res.text()}`);
  return ((await res.json()) as { jobId: string }).jobId;
}

export async function submitDiarize(audioUrl: string): Promise<string> {
  const res = await fetch(`${BASE}/diarize`, {
    method: 'POST',
    headers: pyannoteHeaders(),
    body: JSON.stringify({ url: audioUrl }),
  });
  if (!res.ok) throw new Error(`pyannote diarize submit failed: ${await res.text()}`);
  return ((await res.json()) as { jobId: string }).jobId;
}

export interface IdentifiedSegment {
  start: number;
  end: number;
  speaker: string;
  diarizationSpeaker?: string;
  confidence?: Record<string, number>;
}

export function parseIdentifyOutput(
  output: { identification?: IdentifiedSegment[] } | null,
): IdentifiedSegment[] {
  return output?.identification ?? [];
}

export function parseDiarizeOutput(
  output: { diarization?: IdentifiedSegment[]; segments?: IdentifiedSegment[] } | null,
): IdentifiedSegment[] {
  return (output?.diarization ?? output?.segments ?? []).map((s) => ({
    ...s,
    diarizationSpeaker: s.speaker,
  }));
}

/** Duration-weighted average confidence per diarization speaker; ≥ 50 wins, else `Unknown N`. */
export function resolveSpeakers(identification: IdentifiedSegment[]): Record<string, string> {
  const scores = new Map<string, Map<string, { sum: number; dur: number }>>();
  const order: string[] = [];
  for (const seg of identification) {
    const key = seg.diarizationSpeaker ?? seg.speaker;
    if (!scores.has(key)) {
      scores.set(key, new Map());
      order.push(key);
    }
    const dur = Math.max(0.01, seg.end - seg.start);
    for (const [label, score] of Object.entries(seg.confidence ?? {})) {
      const row = scores.get(key)!;
      const cur = row.get(label) ?? { sum: 0, dur: 0 };
      row.set(label, { sum: cur.sum + score * dur, dur: cur.dur + dur });
    }
  }
  const map: Record<string, string> = {};
  let unknown = 0;
  for (const key of order) {
    let best: string | null = null;
    let bestScore = -1;
    for (const [label, { sum, dur }] of scores.get(key) ?? []) {
      const avg = sum / dur;
      if (avg > bestScore) {
        best = label;
        bestScore = avg;
      }
    }
    map[key] = best && bestScore >= MATCH_CONFIDENCE_MIN ? best : `Unknown ${++unknown}`;
  }
  return map;
}
