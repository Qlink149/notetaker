import type { Glossary, Language } from '@meetingid/shared';
import type { RawTurn } from '@meetingid/pipeline';

/** Audio for one chunk, in whichever form the engine accepts. */
export type ChunkAudio =
  | { kind: 'path'; path: string; mimeType: string }
  | { kind: 'url'; url: string; mimeType: string }
  /** A file already uploaded to the Gemini Files API. */
  | { kind: 'gemini-file'; uri: string; mimeType: string };

export interface ChunkInput {
  audio: ChunkAudio;
  /** Absolute position of the chunk in the meeting; engines return chunk-relative times. */
  startSec: number;
  endSec: number;
  languages: Language[];
  glossary: Glossary | null;
  signal?: AbortSignal;
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
}

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
