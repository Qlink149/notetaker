import { describe, expect, it } from 'vitest';
import { planChunks, splitChunk } from '../src/chunking.js';

describe('planChunks', () => {
  it('returns nothing for zero or invalid duration', () => {
    expect(planChunks(0)).toEqual([]);
    expect(planChunks(Number.NaN)).toEqual([]);
  });

  it('uses one chunk for audio shorter than a chunk', () => {
    expect(planChunks(125)).toEqual([{ index: 0, startSec: 0, endSec: 125 }]);
    expect(planChunks(600)).toEqual([{ index: 0, startSec: 0, endSec: 600 }]);
  });

  it('plans 10-minute chunks with 30-second overlap', () => {
    const chunks = planChunks(1800);
    expect(chunks.slice(0, 3)).toEqual([
      { index: 0, startSec: 0, endSec: 600 },
      { index: 1, startSec: 570, endSec: 1170 },
      { index: 2, startSec: 1140, endSec: 1740 },
    ]);
    // 1800 - 1710 = 90 s tail is allowed as its own chunk
    expect(chunks[3]).toEqual({ index: 3, startSec: 1710, endSec: 1800 });
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i - 1]!.endSec - chunks[i]!.startSec).toBe(30);
    }
  });

  it('extends the last chunk instead of leaving a tail under 90 s', () => {
    const chunks = planChunks(1220); // next start would be 1140 → 80 s tail
    expect(chunks).toEqual([
      { index: 0, startSec: 0, endSec: 600 },
      { index: 1, startSec: 570, endSec: 1220 },
    ]);
    expect(planChunks(620)).toEqual([{ index: 0, startSec: 0, endSec: 620 }]);
  });

  it('covers a 42-minute file end to end', () => {
    const chunks = planChunks(42 * 60);
    expect(chunks[0]!.startSec).toBe(0);
    expect(chunks.at(-1)!.endSec).toBe(2520);
    expect(chunks.every((c) => c.endSec - c.startSec <= 690)).toBe(true);
  });

  it('rejects an overlap as long as the chunk', () => {
    expect(() => planChunks(1000, 30, 30)).toThrow();
  });
});

describe('splitChunk', () => {
  it('splits into two halves overlapping by 30 s', () => {
    const [a, b] = splitChunk({ index: 4, startSec: 570, endSec: 1170 }, 30, 10);
    expect(a).toEqual({ index: 10, startSec: 570, endSec: 885 });
    expect(b).toEqual({ index: 11, startSec: 855, endSec: 1170 });
  });
});
