import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  MT_SAMPLE_RATE as SR,
  alignTrack,
  bestChannelMix,
  fitDrift,
  offsetsPerWindow,
} from '@meetingid/pipeline';
import { decodePcm16k, encodeFlac16k } from '../../services/audio/ffmpeg.js';
import { scratchDir } from '../../services/pyannote/jobs.js';

// Real-speech check of the multi-phone alignment: three "phones" are made from one recording with
// ffmpeg (different start offsets, gains, a 200 Hz high-pass on one, a 0.1 % speed change on another),
// then aligned and mixed with the same code the worker uses. Prints the alignment error per phone.
//   npm run demo:synthetic-phones -w @meetingid/api -- <audio file> [--from 600] [--seconds 180]
const require = createRequire(import.meta.url);
const ffmpeg = (require('@ffmpeg-installer/ffmpeg') as { path: string }).path;

function run(args: string[]): void {
  const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
  if (r.status !== 0) throw new Error(r.stderr.toString().slice(-400));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: 'string', default: '600' },
      seconds: { type: 'string', default: '180' },
    },
  });
  const source = positionals[0];
  if (!source)
    throw new Error('usage: demo:synthetic-phones <audio file> [--from 600] [--seconds 180]');
  const dir = scratchDir('synthetic-phones');
  await mkdir(dir, { recursive: true });
  const seconds = Number(values.seconds);
  const base = join(dir, 'room.wav');
  run(['-ss', values.from!, '-t', String(seconds), '-i', source, '-ac', '1', '-ar', '16000', base]);

  // phones start `trueStart` s after the host pressed Start; the server's timestamp for each is off by `stampError`
  const phones = [
    { name: 'A (reference)', trueStart: 0, stampError: 0.2, filter: 'volume=1.0' },
    {
      name: 'B (0.5x gain, 200 Hz high-pass)',
      trueStart: 2.7,
      stampError: -0.3,
      filter: 'volume=0.5,highpass=f=200',
    },
    {
      name: 'C (0.1% faster clock)',
      trueStart: 11.2,
      stampError: 0.25,
      filter: 'volume=0.8,atempo=1.001',
    },
  ];
  const tracks: Float32Array[] = [];
  for (const [i, p] of phones.entries()) {
    const out = join(dir, `phone${i}.wav`);
    run(['-ss', String(p.trueStart), '-i', base, '-af', p.filter, '-ar', '16000', '-ac', '1', out]);
    const pcm = await decodePcm16k(out, `${out}.pcm`);
    // coarse placement from the (wrong) server timestamp
    const shift = Math.round((p.trueStart + p.stampError) * SR);
    const placed = new Float32Array(pcm.length + shift);
    placed.set(pcm, shift);
    tracks.push(placed);
  }
  const total = Math.max(...tracks.map((t) => t.length));
  const windowSec = Math.min(300, Math.max(30, Math.floor(total / SR / 6)));
  const refErr = phones[0]!.stampError;
  console.log(`source ${source}, ${seconds} s from ${values.from} s; windows ${windowSec} s\n`);
  const aligned: Float32Array[] = [tracks[0]!];
  for (let i = 1; i < tracks.length; i++) {
    const pts = offsetsPerWindow(tracks[0]!, tracks[i]!, { searchSec: 20, windowSec });
    const fit = fitDrift(pts);
    if (!fit) {
      console.log(`${phones[i]!.name}: no match found`);
      aligned.push(tracks[i]!);
      continue;
    }
    aligned.push(alignTrack(tracks[i]!, fit, total));
    const p = phones[i]!;
    // start recovered = stamped start + correction; compare with the truth (shared reference error removed)
    const recovered = p.trueStart + p.stampError - fit.a;
    const errMs = (recovered - (p.trueStart + refErr)) * 1000;
    console.log(
      `${p.name}: stamped ${p.stampError >= 0 ? '+' : ''}${p.stampError * 1000} ms off -> after alignment ${errMs.toFixed(1)} ms off ` +
        `(${pts.length} windows, drift ${(fit.b * 1e6).toFixed(0)} ppm, mean score ${(pts.reduce((s, x) => s + x.score, 0) / pts.length).toFixed(2)})`,
    );
  }
  const mix = bestChannelMix(aligned);
  let peak = 0;
  let bad = 0;
  for (const v of mix.mix) {
    if (!Number.isFinite(v)) bad++;
    peak = Math.max(peak, Math.abs(v));
  }
  const used = mix.chosen.reduce<number[]>((a, c) => ((a[c] = (a[c] ?? 0) + 1), a), []);
  const out = join(dir, 'mix.flac');
  await encodeFlac16k(mix.mix, join(dir, 'mix.pcm'), out);
  console.log(
    `\nmix: ${(mix.mix.length / SR).toFixed(1)} s, ${mix.switches} switches, peak ${peak.toFixed(2)}, non-finite samples ${bad}, ` +
      `phone use ${used.map((n, i) => `${'ABC'[i]}=${Math.round(((n ?? 0) / mix.chosen.length) * 100)}%`).join(' ')}\nwritten ${out}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
