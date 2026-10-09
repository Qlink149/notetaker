import { readFile } from 'node:fs/promises';
import type { DiarizationOutput } from '@meetingid/pipeline';
import { env, requireEnv } from '../../config/env.js';

// pyannoteAI REST client. Facts this relies on are in DECISIONS #26 (docs.pyannote.ai, checked
// 2026-10-07): results expire 24 h after a job completes, `confidence` is precision-2 only,
// identify takes at most 50 voiceprints, and 429 replies carry Retry-After.

const BASE = 'https://api.pyannote.ai/v1';

export type PyannoteModel = 'precision-2' | 'precision-3';
export const PYANNOTE_MODELS: readonly PyannoteModel[] = ['precision-2', 'precision-3'];
export const MAX_IDENTIFY_VOICEPRINTS = 50;
/** Env variable the key comes from; stored on records instead of anything derived from the key. */
export const PYANNOTE_KEY_LABEL = 'PYANNOTEAI_API_KEY';

/**
 * Which pyannote account a request belongs to. Voiceprints may live on a second account: a job, and
 * the media it reads, can only be used with the key that created them.
 */
export type PyannoteAccount = 'main' | 'voiceprint';

/** The env variable (never the key) an account's requests use; falls back to the main key. */
export function keyLabelFor(account: PyannoteAccount): string {
  return account === 'voiceprint' && env().PYANNOTEAI_VOICEPRINT_API_KEY
    ? 'PYANNOTEAI_VOICEPRINT_API_KEY'
    : PYANNOTE_KEY_LABEL;
}

export type JobStatus = 'pending' | 'created' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface PyannoteJob<T> {
  jobId: string;
  status: JobStatus;
  createdAt?: string;
  updatedAt?: string;
  output?: T;
}

export class PyannoteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function pyannoteHeaders(account: PyannoteAccount = 'main'): Record<string, string> {
  return {
    Authorization: `Bearer ${requireEnv(keyLabelFor(account) as 'PYANNOTEAI_API_KEY')}`,
    'Content-Type': 'application/json',
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** fetch against the API; waits out 429s (Retry-After, else 10 s) up to `retries` times. */
async function call<T>(
  path: string,
  init: RequestInit = {},
  retries = 5,
  account: PyannoteAccount = 'main',
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...pyannoteHeaders(account),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (res.status === 429 && attempt < retries) {
      const after = Number(res.headers.get('retry-after'));
      await sleep((Number.isFinite(after) && after > 0 ? after : 10) * 1000);
      continue;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      throw new PyannoteError(
        `pyannote ${init.method ?? 'GET'} ${path} failed: ${res.status} ${body}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  }
}

export interface SpeakerCountOptions {
  numSpeakers?: number;
  minSpeakers?: number;
  maxSpeakers?: number;
}

export interface DiarizeOptions extends SpeakerCountOptions {
  model: PyannoteModel;
}

function speakerCounts(o: SpeakerCountOptions): SpeakerCountOptions {
  if (o.numSpeakers) return { numSpeakers: o.numSpeakers };
  return {
    ...(o.minSpeakers ? { minSpeakers: o.minSpeakers } : {}),
    ...(o.maxSpeakers ? { maxSpeakers: o.maxSpeakers } : {}),
  };
}

/**
 * Request body for /diarize: model pinned, exclusive segments and turn confidence always on.
 * The frame-level `confidence` curve exists only on precision-2 (DECISIONS #26).
 */
export function diarizeBody(url: string, o: DiarizeOptions): Record<string, unknown> {
  return {
    url,
    model: o.model,
    exclusive: true,
    turnLevelConfidence: true,
    ...(o.model === 'precision-2' ? { confidence: true } : {}),
    ...speakerCounts(o),
  };
}

export interface VoiceprintRef {
  /** Opaque label (`<speakerId>-<n>`), never a person's name. */
  label: string;
  voiceprint: string;
}

export interface IdentifyOptions extends DiarizeOptions {
  voiceprints: VoiceprintRef[];
}

/**
 * Request body for /identify. Matching threshold stays 0 so every speaker gets a score for every
 * voiceprint; names are accepted or rejected by our own resolver.
 */
export function identifyBody(url: string, o: IdentifyOptions): Record<string, unknown> {
  const voiceprints = o.voiceprints.filter((v) => v.voiceprint);
  if (!voiceprints.length) throw new Error('identify needs at least one voiceprint');
  if (voiceprints.length > MAX_IDENTIFY_VOICEPRINTS)
    throw new Error(`identify takes at most ${MAX_IDENTIFY_VOICEPRINTS} voiceprints`);
  if (voiceprints.some((v) => /^speaker_/i.test(v.label)))
    throw new Error('voiceprint labels must not start with SPEAKER_');
  return {
    ...diarizeBody(url, o),
    voiceprints,
    matching: { exclusive: true, threshold: 0 },
  };
}

async function submit(
  endpoint: string,
  body: Record<string, unknown>,
  account: PyannoteAccount = 'main',
): Promise<string> {
  const job = await call<{ jobId: string; warning?: string }>(
    `/${endpoint}`,
    { method: 'POST', body: JSON.stringify(body) },
    5,
    account,
  );
  return job.jobId;
}

export const submitDiarize = (url: string, o: DiarizeOptions): Promise<string> =>
  submit('diarize', diarizeBody(url, o));

export const submitIdentify = (url: string, o: IdentifyOptions): Promise<string> =>
  submit('identify', identifyBody(url, o));

export const submitVoiceprint = (url: string, model: PyannoteModel): Promise<string> =>
  submit('voiceprint', { url, model }, 'voiceprint');

export function getJob<T = DiarizationOutput>(
  jobId: string,
  account: PyannoteAccount = 'main',
): Promise<PyannoteJob<T>> {
  return call<PyannoteJob<T>>(`/jobs/${encodeURIComponent(jobId)}`, {}, 5, account);
}

export interface WaitOptions {
  /** Give up after this long (default 30 min; a 45-min meeting takes a few minutes). */
  maxWaitMs?: number;
  onPoll?: (status: JobStatus, waitedMs: number) => void;
  /** The account that created the job (default: the main one). */
  account?: PyannoteAccount;
}

/** Poll until the job finishes; interval grows 5 s → 60 s. Throws on failed/canceled. */
export async function waitForJob<T = DiarizationOutput>(
  jobId: string,
  { maxWaitMs = 30 * 60_000, onPoll, account = 'main' }: WaitOptions = {},
): Promise<PyannoteJob<T>> {
  const started = Date.now();
  let interval = 5000;
  for (;;) {
    const job = await getJob<T>(jobId, account);
    onPoll?.(job.status, Date.now() - started);
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed' || job.status === 'canceled')
      throw new PyannoteError(`pyannote job ${jobId} ${job.status}`, 0);
    if (Date.now() - started > maxWaitMs)
      throw new PyannoteError(`pyannote job ${jobId} still ${job.status} after ${maxWaitMs} ms`, 0);
    await sleep(interval);
    interval = Math.min(60_000, Math.round(interval * 1.5));
  }
}

/** Upload a local file to pyannote's temporary storage; returns its `media://` URL. */
export async function uploadMedia(
  localPath: string,
  key: string,
  account: PyannoteAccount = 'main',
): Promise<string> {
  if (!/^[a-zA-Z0-9\-_./]+$/.test(key)) throw new Error(`invalid media key: ${key}`);
  const mediaUrl = `media://${key}`;
  const { url } = await call<{ url: string }>(
    '/media/input',
    { method: 'POST', body: JSON.stringify({ url: mediaUrl }) },
    5,
    account,
  );
  const res = await fetch(url, { method: 'PUT', body: await readFile(localPath) });
  if (!res.ok) throw new PyannoteError(`pyannote media upload failed: ${res.status}`, res.status);
  return mediaUrl;
}

/** Create a voiceprint from a ≤ 30 s single-speaker clip URL; returns the voiceprint string. */
export async function createVoiceprint(
  url: string,
  model: PyannoteModel = 'precision-2',
): Promise<string> {
  const jobId = await submitVoiceprint(url, model);
  const job = await waitForJob<{ voiceprint?: string }>(jobId, {
    maxWaitMs: 5 * 60_000,
    account: 'voiceprint',
  });
  if (!job.output?.voiceprint) throw new Error('No voiceprint returned');
  return job.output.voiceprint;
}
