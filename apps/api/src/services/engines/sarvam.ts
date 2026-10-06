import {
  NotImplementedError,
  type ChunkInput,
  type ChunkResult,
  type TranscriptionEngine,
} from './types.js';

/**
 * Sarvam AI `saaras:v4` (Indic-native STT with a codemix output mode). Diarization only via its
 * Batch API and no word timestamps. Placeholder so the Phase 2 benchmark can add it.
 */
export class SarvamEngine implements TranscriptionEngine {
  readonly name = 'sarvam' as const;
  readonly accepts = ['path'] as ChunkInput['audio']['kind'][];

  async transcribeChunk(_input: ChunkInput): Promise<ChunkResult> {
    throw new NotImplementedError('Sarvam engine is not implemented in Phase 1');
  }
}
