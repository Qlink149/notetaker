import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Types } from 'mongoose';
import { EngineName } from '@meetingid/shared';
import { formatTimestamp } from '@meetingid/pipeline';
import { env } from '../config/env.js';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { MeetingDataModel, MeetingModel, WorkspaceModel } from '../models/index.js';
import { defaultDeps } from '../pipeline/context.js';
import { enqueue } from '../pipeline/queue.js';
import { Runner } from '../pipeline/runner.js';
import { stages } from '../pipeline/stages/index.js';
import { cutFlac, toAnalysisFlac } from '../services/audio/ffmpeg.js';
import { cloudinaryStorage, meetingFolder } from '../services/storage/cloudinary.js';

// Upload a local recording and process it end to end, in this process, with no browser:
//   npm run eval -w apps/api -- ../../files/200.mp3
//   npm run eval -w apps/api -- ../../files/200.mp3 --start 300 --duration 120   (a 2-minute cut)
//   npm run eval -w apps/api -- ../../files/200.mp3 --engine deepgram --no-run   (queue only; a worker picks it up)
// Writes the transcript (roman + native) to scripts/eval/out/.

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    engine: { type: 'string' },
    title: { type: 'string' },
    start: { type: 'string' },
    duration: { type: 'string' },
    workspace: { type: 'string', default: 'kisna' },
    'no-run': { type: 'boolean', default: false },
  },
});

async function main(): Promise<void> {
  const file = positionals[0];
  if (!file)
    throw new Error(
      'usage: eval <audio file> [--start s --duration s] [--engine gemini|deepgram] [--no-run]',
    );
  const cfg = env();
  await connectMongo(cfg.MONGODB_URI, cfg.MONGODB_DB);
  const workspace = await WorkspaceModel.findOne({ slug: values.workspace }).lean();
  if (!workspace)
    throw new Error(`workspace "${values.workspace}" not found; run npm run seed first`);

  const meetingId = new Types.ObjectId();
  const folder = meetingFolder(workspace.slug, String(meetingId));
  const tmp = await mkdtemp(join(tmpdir(), 'mid-eval-'));
  let source = resolve(file);
  if (values.start || values.duration) {
    const start = Number(values.start ?? 0);
    const flac = join(tmp, 'full.flac');
    await toAnalysisFlac(source, flac);
    source = join(tmp, 'cut.flac');
    await cutFlac(flac, source, start, start + Number(values.duration ?? 120));
  }
  console.log(`Uploading ${basename(file)} …`);
  const up = await cloudinaryStorage.uploadAudio(source, `${folder}/original`);
  await rm(tmp, { recursive: true, force: true });

  const engine = EngineName.parse(values.engine ?? workspace.settings.engine);
  const title =
    values.title ??
    `eval: ${basename(file, extname(file))}${values.start ? ` @${values.start}s` : ''}`;
  await MeetingModel.create({
    _id: meetingId,
    workspaceId: workspace._id,
    title,
    status: 'processing',
    stage: 'ingest',
    engine,
    languages: workspace.settings.languages,
    audio: { originalUrl: up.url, originalPublicId: up.publicId },
  });
  await enqueue({ meetingId, stage: 'ingest' });
  console.log(`Meeting ${String(meetingId)} queued (engine ${engine}).`);
  if (values['no-run']) return disconnectMongo();

  const started = Date.now();
  const runner = new Runner(defaultDeps(), stages, { workerId: `eval-${process.pid}` });
  // Drain repeatedly: retries are scheduled in the future, so wait for them.
  for (;;) {
    await runner.drain();
    const m = await MeetingModel.findById(meetingId).lean();
    if (!m || m.stage === 'done' || m.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  const meeting = await MeetingModel.findById(meetingId).lean();
  const data = await MeetingDataModel.findOne({ meetingId }).lean();
  const lines = data?.lines ?? [];
  const words = lines.reduce((n, l) => n + l.textRoman.split(/\s+/).filter(Boolean).length, 0);
  const longest = lines.reduce((x, l) => Math.max(x, l.end - l.start), 0);
  const outDir = resolve(import.meta.dirname, '../../../../scripts/eval/out');
  await mkdir(outDir, { recursive: true });
  const out = join(outDir, `${basename(file, extname(file))}-${String(meetingId)}.txt`);
  await writeFile(
    out,
    [
      `# ${title}`,
      `status=${meeting?.status} coverage=${JSON.stringify(meeting?.coverage)} summary=${meeting?.summaryStatus}`,
      '',
      ...lines.map(
        (l) =>
          `[${formatTimestamp(l.start)}] ${l.speakerName}: ${l.textRoman}\n           ${l.textNative}`,
      ),
      '',
      '## Summary',
      meeting?.summary ?? '(none)',
      '',
      '## Action items',
      ...(meeting?.actionItems ?? []).map((a) => `- ${a.speakerName}: ${a.text}`),
    ].join('\n'),
  );
  console.table({
    status: meeting?.status,
    durationSec: meeting?.durationSec,
    chunks: `${meeting?.progress.chunksDone}/${meeting?.progress.chunksTotal}`,
    coverage: meeting?.coverage?.ratio,
    lines: lines.length,
    words,
    longestLineSec: Math.round(longest * 10) / 10,
    summary: meeting?.summaryStatus,
    error: meeting?.error?.message ?? '',
    wallClockSec: Math.round((Date.now() - started) / 1000),
    ...meeting?.cost,
  });
  console.log(`Transcript: ${out}`);
  await disconnectMongo();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  await disconnectMongo().catch(() => undefined);
  process.exit(1);
});
