import { join } from 'node:path';
import { planChunks, silenceThresholdDb, speechFromSilences } from '@meetingid/pipeline';
import { MeetingDataModel, MeetingModel } from '../../models/index.js';
import type { StageContext, StageHandler } from '../context.js';
import { FatalError } from '../errors.js';
import { loadMeeting, loadWorkspaceContext } from '../meetings.js';
import { createLimiter } from '../../lib/limiter.js';
import { enqueue } from '../queue.js';
import { startDiarization } from './22-diarize.js';

export const CHUNK_SEC = 600;
export const OVERLAP_SEC = 30;
const FLAC = 'audio/flac';
/** Chunks cut and uploaded at the same time. */
const CUT_PARALLEL = 3;

/**
 * Probe → 16 kHz mono FLAC (what every engine gets; fixes A1) → silencedetect (threshold raised on noisy recordings) →
 * plan 10-min chunks → cut each chunk locally and upload it to Gemini Files when Gemini is the
 * engine → one transcribe job per chunk. Only the original lives in Cloudinary; chunk audio is
 * re-cut from it on demand (DECISIONS #13). Idempotent: a re-run rebuilds MeetingData.
 */
export const ingestStage: StageHandler = {
  async run({ job, deps, log, tmpDir }: StageContext) {
    const meeting = await loadMeeting(job.meetingId);
    await loadWorkspaceContext(meeting.workspaceId); // fails fast if the workspace is gone

    const clock = { start: Date.now(), last: Date.now() };
    const lap = (): number => {
      const now = Date.now();
      const ms = now - clock.last;
      clock.last = now;
      return ms;
    };
    const original = join(tmpDir, 'original');
    await deps.storage.download(meeting.audio.originalUrl, original);
    const downloadMs = lap();

    // Duration comes from the server, never the browser (fixes C3).
    const info = await deps.audio.probe(original);
    const analysis = join(tmpDir, 'analysis.flac');
    await deps.audio.toAnalysisFlac(original, analysis);
    // later stages (speaker analysis, gap fill, re-uploads) reuse this instead of fetching the original again
    await deps.analysisCache?.put(meeting.audio.originalUrl, analysis).catch(() => null);
    let durationSec = (await deps.audio.probe(analysis)).durationSec;
    if (!(durationSec > 0)) durationSec = await deps.audio.decodedDuration(analysis);
    if (!(durationSec >= 1))
      throw new FatalError('No speech detected: the recording is empty or shorter than a second');
    const convertMs = lap();
    log.info(
      { durationSec, channels: info.channels, sampleRate: info.sampleRate, codec: info.codec },
      'probed',
    );

    const noiseFloor = await deps.audio.noiseFloorDb(analysis);
    const thresholdDb = silenceThresholdDb(noiseFloor);
    const silences = await deps.audio.detectSilences(analysis, thresholdDb);
    const speechSegments = speechFromSilences(silences, durationSec);
    const silenceMs = lap();

    const plan = planChunks(durationSec, CHUNK_SEC, OVERLAP_SEC);
    const useGemini = meeting.engine === 'gemini';

    // A re-run after a failure keeps the chunks already transcribed and the audio already uploaded
    // (never pay for a chunk twice).
    const before = await MeetingDataModel.findOne({ meetingId: meeting._id }, { chunks: 1 }).lean();
    const kept = new Map(
      (before?.chunks ?? [])
        .filter((c) => c.status === 'done' || (c.status === 'pending' && c.geminiFileUri))
        .map((c) => [`${c.index}:${c.startSec}:${c.endSec}`, c]),
    );
    const chunks = plan.map(
      (c) =>
        kept.get(`${c.index}:${c.startSec}:${c.endSec}`) ?? {
          ...c,
          audioUrl: null,
          audioPublicId: null,
          geminiFileUri: null,
          geminiFileName: null,
          geminiKeyId: null,
          uploadedAt: null,
          model: null,
          status: 'pending' as const,
          attempts: 0,
          parent: null,
          rawTurns: [],
          responseId: null,
        },
    );
    const todo = chunks.filter((c) => c.status === 'pending');

    await MeetingDataModel.updateOne(
      { meetingId: meeting._id },
      {
        $set: {
          chunks,
          speechSegments,
          turns: [],
          lines: [],
          speakerMap: {},
          speakerCards: [],
          speakerSource: 'text-fallback',
          diarize: null,
          phase1: null,
        },
      },
      { upsert: true },
    );
    await MeetingModel.updateOne(
      { _id: meeting._id },
      {
        $set: {
          durationSec: Math.round(durationSec * 10) / 10,
          'audio.analysisUrl': null,
          'audio.analysisPublicId': null,
          'audio.playbackUrl': deps.storage.playbackUrl(meeting.audio.originalPublicId),
          status: 'processing',
          stage: 'transcribe',
          progress: { chunksTotal: chunks.length, chunksDone: chunks.length - todo.length },
          error: null,
        },
      },
    );
    // diarization state first, so a fast chunk cannot finish and assemble without waiting for it
    await startDiarization(meeting, deps.speakerSource);

    // Cut and upload the chunks a few at a time, and queue each one's transcription the moment its audio is
    // ready, so the first chunks are being transcribed while the last are still uploading.
    const limit = createLimiter(CUT_PARALLEL);
    await Promise.all(
      todo.map((c) =>
        limit.run(async () => {
          if (useGemini && !c.geminiFileUri) {
            const path = join(tmpDir, `chunk-${c.index}.flac`);
            await deps.audio.cutFlac(analysis, path, c.startSec, c.endSec);
            const gem = await deps.geminiFiles.upload(
              path,
              FLAC,
              `${String(meeting._id)}-${c.index}`,
            );
            await MeetingDataModel.updateOne(
              {
                meetingId: meeting._id,
                chunks: { $elemMatch: { index: c.index, status: 'pending' } },
              },
              {
                $set: {
                  'chunks.$.geminiFileUri': gem.uri,
                  'chunks.$.geminiFileName': gem.name,
                  'chunks.$.geminiKeyId': gem.keyId,
                  'chunks.$.uploadedAt': deps.now(),
                },
              },
            );
          }
          await enqueue({ meetingId: meeting._id, stage: 'transcribe', step: c.index });
        }),
      ),
    );
    const chunksMs = lap();
    log.info(
      {
        chunks: chunks.length,
        timingMs: {
          download: downloadMs,
          convert: convertMs,
          silence: silenceMs,
          chunks: chunksMs,
        },
        noiseFloor,
        thresholdDb,
        speechSec: Math.round(speechSegments.reduce((s, x) => s + x.end - x.start, 0)),
      },
      'ingested',
    );
  },
};
