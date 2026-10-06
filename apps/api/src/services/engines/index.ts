import type { BenchmarkEngineName } from '@meetingid/shared';
import { DeepgramEngine } from './deepgram.js';
import { GeminiEngine } from './gemini.js';
import { GeminiTranscribeEngine } from './geminiTranscribe.js';
import { SarvamEngine } from './sarvam.js';
import type { TranscriptionEngine } from './types.js';

export type EngineFactory = (name: BenchmarkEngineName) => TranscriptionEngine;

/** Default factory. Tests inject their own through the worker deps. */
export const createEngine: EngineFactory = (name) => {
  switch (name) {
    case 'gemini':
      return new GeminiEngine();
    case 'deepgram':
      return new DeepgramEngine();
    case 'gemini-transcribe':
      return new GeminiTranscribeEngine();
    case 'sarvam':
      return new SarvamEngine();
  }
};
