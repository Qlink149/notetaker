import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { planChunks, speechFromSilences } from '@meetingid/pipeline';
import { detectSilences, probe, toAnalysisFlac } from '../services/audio/ffmpeg.js';

// Offline check of the ingest audio steps on local files (no network, no database):
//   npm run probe -w @meetingid/api -- ../../files/*.mp3
for (const file of process.argv.slice(2)) {
  const dir = await mkdtemp(join(tmpdir(), 'probe-'));
  try {
    const info = await probe(file);
    const flac = join(dir, 'a.flac');
    const t0 = Date.now();
    await toAnalysisFlac(file, flac);
    const dur = (await probe(flac)).durationSec;
    const speech = speechFromSilences(await detectSilences(flac), dur);
    const speechSec = speech.reduce((s, x) => s + x.end - x.start, 0);
    console.log(
      JSON.stringify({
        file: basename(file),
        min: +(dur / 60).toFixed(1),
        channels: info.channels,
        sampleRate: info.sampleRate,
        codec: info.codec,
        speechPct: Math.round((100 * speechSec) / dur),
        segments: speech.length,
        chunks: planChunks(dur)
          .map((c) => `${c.startSec}-${c.endSec}`)
          .join(' '),
        ingestSec: Math.round((Date.now() - t0) / 1000),
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
