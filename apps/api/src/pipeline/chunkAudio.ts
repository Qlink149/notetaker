import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Deps } from './context.js';

/**
 * The meeting's 16 kHz mono FLAC, built from the stored original at most once per job, and kept on the
 * worker's disk between jobs when `deps.analysisCache` is set (so the original is fetched and converted once
 * per meeting, not once per stage). Used for chunk cuts, pyannote and Deepgram.
 */
export async function ensureAnalysisFlac(
  deps: Pick<Deps, 'storage' | 'audio' | 'analysisCache'>,
  tmpDir: string,
  originalUrl: string,
): Promise<string> {
  const flac = join(tmpDir, 'analysis.flac');
  if (existsSync(flac)) return flac;
  const cached = await deps.analysisCache?.get(originalUrl);
  if (cached) return cached;
  const original = join(tmpDir, 'original');
  await deps.storage.download(originalUrl, original);
  await deps.audio.toAnalysisFlac(original, flac);
  return (await deps.analysisCache?.put(originalUrl, flac).catch(() => null)) ?? flac;
}

/**
 * Chunk audio is not stored (Cloudinary's free plan caps raw files at 10 MB and audio at 100 MB;
 * DECISIONS #13). When a stage needs a chunk as a file (Gemini file expired, Deepgram, benchmark),
 * it is re-cut here from the stored original. The original and its 16 kHz mono FLAC are fetched
 * at most once per job (cached in the job's temp directory).
 */
export async function materializeChunk(
  deps: Pick<Deps, 'storage' | 'audio' | 'analysisCache'>,
  tmpDir: string,
  originalUrl: string,
  startSec: number,
  endSec: number,
  name: string,
): Promise<string> {
  const flac = await ensureAnalysisFlac(deps, tmpDir, originalUrl);
  const out = join(tmpDir, `${name}.flac`);
  await deps.audio.cutFlac(flac, out, startSec, endSec);
  return out;
}
