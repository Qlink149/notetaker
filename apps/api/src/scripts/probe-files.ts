import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { planChunks, silenceThresholdDb, speechFromSilences } from '@meetingid/pipeline';
import { detectSilences, noiseFloorDb, probe, toAnalysisFlac } from '../services/audio/ffmpeg.js';

// Offline check of the ingest audio steps on local files (no network, no database):
//   npm run probe -w @meetingid/api -- ../../files/*.mp3
// Reports speech time at the old fixed -35 dB threshold and at the noise-floor rule.
const speechSec = async (flac: string, dur: number, db: number) => {
  const segs = speechFromSilences(await detectSilences(flac, db), dur);
  return { sec: Math.round(segs.reduce((s, x) => s + x.end - x.start, 0)), segments: segs.length };
};

for (const file of process.argv.slice(2)) {
  const dir = await mkdtemp(join(tmpdir(), 'probe-'));
  try {
    const info = await probe(file);
    const flac = join(dir, 'a.flac');
    await toAnalysisFlac(file, flac);
    const dur = (await probe(flac)).durationSec;
    const floor = await noiseFloorDb(flac);
    const threshold = silenceThresholdDb(floor);
    const before = await speechSec(flac, dur, -35);
    const after = await speechSec(flac, dur, threshold);
    console.log(
      JSON.stringify({
        file: basename(file),
        durationSec: Math.round(dur),
        channels: info.channels,
        noiseFloorDb: floor,
        thresholdDb: threshold,
        speechBefore: `${before.sec}s (${Math.round((100 * before.sec) / dur)}%, ${before.segments} seg)`,
        speechAfter: `${after.sec}s (${Math.round((100 * after.sec) / dur)}%, ${after.segments} seg)`,
        chunks: planChunks(dur).length,
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
