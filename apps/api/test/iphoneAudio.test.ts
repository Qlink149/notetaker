import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';
import { lostAudio, probe, toAnalysisFlac } from '../src/services/audio/ffmpeg.js';
import { makeFixture } from './helpers.js';

// iPhone Safari records a fragmented MP4 whose fragments hold three sample runs each. The ffmpeg we ship (4.1) restarts
// the clock at every run after the first and dropped about half of the audio: an 18 minute recording came out as 9.
// safari-three-runs.mp4 is a 45 s synthetic tone (no speech) with exactly that layout, built from the real file's
// container header; fragmented-one-run.mp4 is the same audio with one run per fragment.
const FIXTURES = join(import.meta.dirname, 'fixtures');

let dir: string;
beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://localhost:1/unused',
    JWT_SECRET: 'x'.repeat(40),
  });
  resetEnvCache();
  dir = await mkdtemp(join(tmpdir(), 'iphone-audio-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function convert(fixture: string) {
  const input = join(dir, fixture);
  await copyFile(join(FIXTURES, fixture), input);
  const output = join(dir, `${fixture}.flac`);
  await toAnalysisFlac(input, output);
  return {
    declared: (await probe(input)).durationSec,
    converted: (await probe(output)).durationSec,
    leftovers: (await readdir(dir)).filter((f) => f.includes('.remux.') || f.includes('.second.')),
  };
}

describe('the rule for noticing lost audio', () => {
  it('flags a result that is clearly shorter than the file says', () => {
    expect(lostAudio(1128.15, 546.6)).toBe(true);
    expect(lostAudio(45, 22)).toBe(true);
  });

  it('leaves normal conversions alone', () => {
    expect(lostAudio(1146.73, 1146.75)).toBe(false);
    expect(lostAudio(1000, 905)).toBe(false); // within 10% of the declared length
    expect(lostAudio(60, 52)).toBe(false); // 13% short but only 8 s: not worth a second pass
  });

  it('has nothing to compare when the file declares no length', () => {
    expect(lostAudio(0, 300)).toBe(false);
    expect(lostAudio(Number.NaN, 300)).toBe(false);
  });
});

describe('converting an iPhone Safari recording', () => {
  it('keeps the whole recording (it used to keep only about half)', async () => {
    const r = await convert('safari-three-runs.mp4');
    expect(r.declared).toBeGreaterThan(44.5);
    expect(r.converted).toBeGreaterThan(r.declared - 0.5);
    expect(r.converted).toBeLessThan(r.declared + 0.5);
    expect(r.leftovers).toEqual([]); // temporary files are cleaned up
  });

  it('converts a fragmented MP4 with one run per fragment exactly as before', async () => {
    const r = await convert('fragmented-one-run.mp4');
    expect(Math.abs(r.converted - r.declared)).toBeLessThan(0.5);
    expect(r.leftovers).toEqual([]);
  });

  it('converts an ordinary file exactly as before', async () => {
    const wav = await makeFixture(dir);
    const out = join(dir, 'plain.flac');
    await toAnalysisFlac(wav, out);
    expect(Math.abs((await probe(out)).durationSec - (await probe(wav)).durationSec)).toBeLessThan(
      0.5,
    );
  });
});
