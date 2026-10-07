import { join } from 'node:path';
import { planChunks, silenceThresholdDb, speechFromSilences } from '@meetingid/pipeline';
import { MeetingDataModel, MeetingModel } from '../../models/index.js';
import type { StageContext, StageHandler } from '../context.js';
import { FatalError } from '../errors.js';
import { loadMeeting, loadWorkspaceContext } from '../meetings.js';
import { enqueue } from '../queue.js';

export const CHUNK_SEC = 600;
export const OVERLAP_SEC = 30;
const FLAC = 'audio/flac';

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

    const original = join(tmpDir, 'original');
    await deps.storage.download(meeting.audio.originalUrl, original);

    // Duration comes from the server, never the browser (fixes C3).
    const info = await deps.audio.probe(original);
    const analysis = join(tmpDir, 'analysis.flac');
    await deps.audio.toAnalysisFlac(original, analysis);
    let durationSec = (await deps.audio.probe(analysis)).durationSec;
    if (!(durationSec > 0)) durationSec = await deps.audio.decodedDuration(analysis);
    if (!(durationSec >= 1))
      throw new FatalError('No speech detected: the recording is empty or shorter than a second');
    log.info(
      { durationSec, channels: info.channels, sampleRate: info.sampleRate, codec: info.codec },
      'probed',
    );

    const noiseFloor = await deps.audio.noiseFloorDb(analysis);
    const thresholdDb = silenceThresholdDb(noiseFloor);
    const silences = await deps.audio.detectSilences(analysis, thresholdDb);
    const speechSegments = speechFromSilences(silences, durationSec);

    const plan = planChunks(durationSec, CHUNK_SEC, OVERLAP_SEC);
    const useGemini = meeting.engine === 'gemini';
    const chunks = [];
    for (const c of plan) {
      const path = join(tmpDir, `chunk-${c.index}.flac`);
      await deps.audio.cutFlac(analysis, path, c.startSec, c.endSec);
      const gem = useGemini
        ? await deps.geminiFiles.upload(path, FLAC, `${String(meeting._id)}-${c.index}`)
        : null;
      chunks.push({
        ...c,
        audioUrl: null,
        audioPublicId: null,
        geminiFileUri: gem?.uri ?? null,
        geminiFileName: gem?.name ?? null,
        geminiKeyId: gem?.keyId ?? null,
        uploadedAt: gem ? deps.now() : null,
        model: null,
        status: 'pending' as const,
        attempts: 0,
        parent: null,
        rawTurns: [],
      });
    }

    await MeetingDataModel.updateOne(
      { meetingId: meeting._id },
      { $set: { chunks, speechSegments, turns: [], lines: [], speakerMap: {} } },
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
          progress: { chunksTotal: chunks.length, chunksDone: 0 },
          error: null,
        },
      },
    );
    for (const c of chunks)
      await enqueue({ meetingId: meeting._id, stage: 'transcribe', step: c.index });
    log.info(
      {
        chunks: chunks.length,
        noiseFloor,
        thresholdDb,
        speechSec: Math.round(speechSegments.reduce((s, x) => s + x.end - x.start, 0)),
      },
      'ingested',
    );
  },
};
