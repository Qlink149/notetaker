import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The 16 kHz mono FLAC of a meeting's original, kept on the worker's disk between jobs. Every pipeline job
 * gets its own temp folder, so without this each stage that needs the audio (speaker analysis, gap fill,
 * a chunk re-upload under another Gemini key) downloads the whole original from storage again and converts
 * it again, which is slow on a small CPU. Only the most recent few meetings are kept.
 */
export interface AnalysisCache {
  /** Path of the cached FLAC for this original, or null. */
  get(originalUrl: string): Promise<string | null>;
  /** Copy a finished FLAC in; returns the cached path (or null if it was too big to keep). */
  put(originalUrl: string, flacPath: string): Promise<string | null>;
}

const MAX_FILE_BYTES = 400 * 1024 * 1024;

export function createAnalysisCache(
  dir = join(tmpdir(), 'mid-analysis-cache'),
  keep = 2,
): AnalysisCache {
  const pathFor = (url: string): string =>
    join(dir, `${createHash('sha1').update(url).digest('hex')}.flac`);

  async function evict(): Promise<void> {
    const files = await Promise.all(
      (await readdir(dir))
        .filter((f) => f.endsWith('.flac'))
        .map(async (f) => ({ f, t: (await stat(join(dir, f))).mtimeMs })),
    );
    files.sort((a, b) => b.t - a.t);
    for (const old of files.slice(keep)) await rm(join(dir, old.f), { force: true });
  }

  return {
    async get(url) {
      const p = pathFor(url);
      try {
        await stat(p);
        const now = new Date();
        await utimes(p, now, now); // most recently used
        return p;
      } catch {
        return null;
      }
    },
    async put(url, flacPath) {
      if ((await stat(flacPath)).size > MAX_FILE_BYTES) return null;
      await mkdir(dir, { recursive: true });
      const p = pathFor(url);
      const part = `${p}.${process.pid}.${Date.now()}.part`;
      await copyFile(flacPath, part);
      await rename(part, p); // whole file or nothing: a reader never sees a half-written copy
      await evict();
      return p;
    },
  };
}
