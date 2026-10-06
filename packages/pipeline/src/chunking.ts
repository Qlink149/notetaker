export interface Chunk {
  index: number;
  startSec: number;
  endSec: number;
}

export interface PlanOptions {
  /** A final chunk shorter than this is folded into the previous chunk. */
  minTailSec?: number;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Plan overlapping chunks over `durationSec`.
 * Chunks start every `chunkSec - overlapSec` seconds and are `chunkSec` long, so adjacent chunks
 * share `overlapSec` seconds. When the next chunk would be shorter than `minTailSec`, the current
 * chunk is extended to the end instead.
 */
export function planChunks(
  durationSec: number,
  chunkSec = 600,
  overlapSec = 30,
  { minTailSec = 90 }: PlanOptions = {},
): Chunk[] {
  if (!(durationSec > 0)) return [];
  if (overlapSec < 0 || overlapSec >= chunkSec) {
    throw new Error(`overlapSec (${overlapSec}) must be in [0, chunkSec)`);
  }
  const stride = chunkSec - overlapSec;
  const chunks: Chunk[] = [];
  let start = 0;
  for (let index = 0; ; index++) {
    let end = start + chunkSec;
    const nextStart = start + stride;
    if (end >= durationSec || durationSec - nextStart < minTailSec) end = durationSec;
    chunks.push({ index, startSec: round3(start), endSec: round3(end) });
    if (end >= durationSec) break;
    start = nextStart;
  }
  return chunks;
}

/**
 * Split one chunk into two halves that overlap by `overlapSec` around the midpoint.
 * Used when a chunk fails twice (repetition loop or truncation).
 */
export function splitChunk(
  chunk: Chunk,
  overlapSec = 30,
  firstIndex = chunk.index,
): [Chunk, Chunk] {
  const mid = (chunk.startSec + chunk.endSec) / 2;
  const half = Math.min(overlapSec / 2, (chunk.endSec - chunk.startSec) / 4);
  return [
    { index: firstIndex, startSec: chunk.startSec, endSec: round3(mid + half) },
    { index: firstIndex + 1, startSec: round3(mid - half), endSec: chunk.endSec },
  ];
}
