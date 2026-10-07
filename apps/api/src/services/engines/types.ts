import type { Glossary, Language } from '@meetingid/shared';
import type { RawTurn } from '@meetingid/pipeline';

/** Audio for one chunk, in whichever form the engine accepts. */
export type ChunkAudio =
  | { kind: 'path'; path: string; mimeType: string }
  | { kind: 'url'; url: string; mimeType: string }
  /** A file already uploaded to the Gemini Files API. */
  | { kind: 'gemini-file'; uri: string; mimeType: string; keyId?: string | null };

export interface ChunkInput {
  audio: ChunkAudio;
  /** Absolute position of the chunk in the meeting; engines return chunk-relative times. */
  startSec: number;
  endSec: number;
  languages: Language[];
  glossary: Glossary | null;
  signal?: AbortSignal;
  /** Produces the chunk as a local file when the engine has to (re-)upload it. */
  localPath?: () => Promise<string>;
}

export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
  /** Seconds of audio billed by per-second engines (Deepgram). */
  audioSec: number;
}

export interface ChunkResult {
  /** Turns with times relative to the start of the chunk audio. */
  turns: RawTurn[];
  usage: EngineUsage;
  model: string;
  /** `truncated` when the engine stopped at its output limit. */
  finish: 'complete' | 'truncated';
  /** Set when the engine uploaded the chunk itself (e.g. under a different Gemini key). */
  uploaded?: { uri: string; name: string; keyId: string };
  /** The engine's untouched reply (Gemini), stored so turns can be rebuilt without a new call. */
  raw?: EngineRawResponse;
}

/** One engine reply exactly as received, with everything needed to reproduce the request. */
export interface EngineRawResponse {
  engine: string;
  model: string;
  /** TRANSCRIBE_PROMPT_VERSION of the prompt template. */
  promptVersion: string;
  /** sha256 of system instruction + user text + schema (changes with the glossary too). */
  promptHash: string;
  prompt: string;
  userText: string;
  /** Interaction status, e.g. completed / incomplete. */
  status: string;
  /** The model's output text (the transcript JSON) before any parsing. */
  text: string | null;
  /** The response body as returned by the API, without the SDK's HTTP metadata (storableResponse). */
  response: unknown;
  usage: EngineUsage;
  /** Name of the env variable holding the key (e.g. GEMINI_API_KEY1). Never the key or a hash of it. */
  keyLabel: string | null;
  receivedAt: Date;
}

/** Errors thrown after a reply arrived (invalid JSON, bad status) carry the reply with them. */
export function attachRaw<E extends Error>(err: E, raw: EngineRawResponse): E {
  (err as E & { engineRaw?: EngineRawResponse }).engineRaw = raw;
  return err;
}
export const rawOf = (err: unknown): EngineRawResponse | null =>
  (err as { engineRaw?: EngineRawResponse } | null)?.engineRaw ?? null;

export interface TranscriptionEngine {
  readonly name: 'gemini' | 'deepgram' | 'gemini-transcribe' | 'sarvam';
  /** Which audio forms this engine can consume, most preferred first. */
  readonly accepts: ChunkAudio['kind'][];
  transcribeChunk(input: ChunkInput): Promise<ChunkResult>;
}

export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
}

export const LANGUAGE_NAMES: Record<Language, string> = {
  hi: 'Hindi',
  gu: 'Gujarati',
  en: 'English',
};

/** BCP-47 codes used by engines that take explicit language hints. */
export const LANGUAGE_BCP47: Record<Language, string> = {
  hi: 'hi-IN',
  gu: 'gu-IN',
  en: 'en-IN',
};
