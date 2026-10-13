import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnalysisCache } from '../src/lib/analysisCache.js';
import { ensureAnalysisFlac } from '../src/pipeline/chunkAudio.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cache-test-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const make = async (name: string, text: string): Promise<string> => {
  const p = join(root, name);
  await writeFile(p, text);
  return p;
};

describe('analysis cache', () => {
  it('returns what was put, and nothing for an unknown original', async () => {
    const cache = createAnalysisCache(join(root, 'c'));
    expect(await cache.get('b2://a')).toBeNull();
    const got = await cache.put('b2://a', await make('a.flac', 'AAA'));
    expect(got).not.toBeNull();
    expect(await readFile((await cache.get('b2://a'))!, 'utf8')).toBe('AAA');
  });

  it('keeps only the most recently used few and leaves no half-written files', async () => {
    const dir = join(root, 'c');
    const cache = createAnalysisCache(dir, 2);
    for (const k of ['1', '2', '3']) {
      await cache.put(`b2://${k}`, await make(`${k}.flac`, k));
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(await cache.get('b2://1')).toBeNull(); // oldest went
    expect(await cache.get('b2://2')).not.toBeNull();
    expect(await cache.get('b2://3')).not.toBeNull();
    expect((await readdir(dir)).filter((f) => f.endsWith('.part'))).toEqual([]);
  });
});

describe('ensureAnalysisFlac across jobs', () => {
  const makeDeps = (cache?: ReturnType<typeof createAnalysisCache>) => {
    const download = vi.fn(async (_url: string, dest: string) => writeFile(dest, 'orig'));
    const toAnalysisFlac = vi.fn(async (_i: string, out: string) => writeFile(out, 'flac'));
    return {
      download,
      toAnalysisFlac,
      deps: {
        storage: { download },
        audio: { toAnalysisFlac },
        ...(cache ? { analysisCache: cache } : {}),
      } as unknown as Parameters<typeof ensureAnalysisFlac>[0],
    };
  };

  it('downloads and converts once for several jobs with their own temp folders', async () => {
    const { deps, download, toAnalysisFlac } = makeDeps(createAnalysisCache(join(root, 'c')));
    for (let i = 0; i < 3; i++) {
      const tmp = await mkdtemp(join(root, 'job-'));
      const flac = await ensureAnalysisFlac(deps, tmp, 'b2://meeting/original');
      expect(await readFile(flac, 'utf8')).toBe('flac');
      await rm(tmp, { recursive: true, force: true }); // the runner deletes each job's folder
    }
    expect(download).toHaveBeenCalledTimes(1);
    expect(toAnalysisFlac).toHaveBeenCalledTimes(1);
  });

  it('works as before without a cache (each job starts from the original)', async () => {
    const { deps, download } = makeDeps();
    for (let i = 0; i < 2; i++) await ensureAnalysisFlac(deps, await mkdtemp(join(root, 'job-')), 'b2://x');
    expect(download).toHaveBeenCalledTimes(2);
  });
});
