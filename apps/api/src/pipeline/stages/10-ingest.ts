import { join } from 'node:path';
import { planChunks, silenceThresholdDb, speechFromSilences } from '@meetingid/pipeline';
import { MeetingDataModel, MeetingModel } from '../../models/index.js';
import type { StageContext, StageHandler } from '../context.js';
import { FatalError } from '../errors.js';
import { loadMeeting, loadWorkspaceContext } from '../meetings.js';
import { createLimiter } from '../../lib/limiter.js';
import { lostAudio } from '../../services/audio/ffmpeg.js';
import { enqueue } from '../queue.js';
import { startDiarization } from './22-diarize.js';

export const CHUNK_SEC = 600;
export const OVERLAP_SEC = 30;
const FLAC = 'audio/flac';
/** Chunks cut and uploaded at the same time. */
const CUT_PARALLEL = 3;

/** m:ss for the warning shown to people. */
const mmss = (sec: number): string =>
  `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

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
    // The conversion repairs the known cause (iPhone Safari files); if the audio is still clearly shorter than the
    // file declares, say so on the meeting instead of presenting a partial transcript as complete.
    const audioWarning = lostAudio(info.durationSec, durationSec)
      ? `The file is ${mmss(info.durationSec)} long but only ${mmss(durationSec)} of audio could be read, so part of the recording may be missing.`
      : null;
    if (audioWarning)
      log.warn(
        { declaredSec: info.durationSec, readSec: durationSec },
        'audio shorter than declared',
      );
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
    // A chunk that was split (Gemini refused it or looped) keeps its finished pieces too. The pieces are
    // renumbered after the new plan, since audio added to the meeting gives the plan more chunks.
    const chunksBefore = before?.chunks ?? [];
    const pieces: typeof chunksBefore = [];
    let nextIndex = plan.length;
    for (const c of plan) {
      const parent = chunksBefore.find(
        (b) =>
          b.status === 'superseded' &&
          (b.parent ?? null) === null &&
          b.index === c.index &&
          b.startSec === c.startSec &&
          b.endSec === c.endSec,
      );
      if (!parent) continue;
      const family: typeof chunksBefore = [];
      const walk = (index: number): void => {
        for (const k of chunksBefore.filter((b) => b.parent === index)) {
          family.push(k);
          if (k.status === 'superseded') walk(k.index);
        }
      };
      walk(parent.index);
      if (!family.length || family.some((k) => k.status !== 'done' && k.status !== 'superseded'))
        continue;
      const renumber = new Map(family.map((k) => [k.index, nextIndex++]));
      kept.set(`${c.index}:${c.startSec}:${c.endSec}`, parent);
      for (const k of family)
        pieces.push({
          ...k,
          index: renumber.get(k.index)!,
          parent: k.parent === parent.index ? parent.index : renumber.get(k.parent!)!,
        });
    }
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
    chunks.push(...pieces);
    const todo = chunks.filter((c) => c.status === 'pending');
    const live = chunks.filter((c) => c.status !== 'superseded');

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
          audioWarning,
          status: 'processing',
          stage: 'transcribe',
          progress: { chunksTotal: live.length, chunksDone: live.length - todo.length },
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
