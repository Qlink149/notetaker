import { join } from 'node:path';
import {
  MT_SAMPLE_RATE as SR,
  alignTrack,
  bestChannelMix,
  fitDrift,
  loudnessDb,
  offsetsPerWindow,
} from '@meetingid/pipeline';
import { MeetingModel } from '../../models/index.js';
import {
  LoudnessModel,
  ParticipantModel,
  SessionModel,
  type ParticipantDoc,
} from '../../models/session.js';
import type { StageContext, StageHandler } from '../context.js';
import { FatalError } from '../errors.js';
import { loadMeeting } from '../meetings.js';
import { enqueue } from '../queue.js';

// PROTOTYPE (tested with synthetic tracks, not yet with real phones): turn the phones' uploaded
// parts into one recording and hand it to the normal pipeline.

/** Put a phone's recording on the session timeline: its first sample was `coarseSec` after Start. */
export function placeOnTimeline(phone: Float32Array, coarseSec: number): Float32Array {
  const shift = Math.round(coarseSec * SR);
  if (shift >= 0) {
    const out = new Float32Array(phone.length + shift);
    out.set(phone, shift);
    return out;
  }
  return phone.slice(Math.min(phone.length, -shift));
}

export interface TrackReport {
  name: string;
  /** From the server timestamps of the phone's first sample, relative to the host's Start. */
  coarseSec: number;
  /**
   * Correction found by matching sound between phones (seconds): coarseSec + fineSec is the phone's
   * real start, relative to the reference phone's timeline. Null when no match was found.
   */
  fineSec: number | null;
  /** Clock drift found, in parts per million (positive: the phone's clock runs slow). */
  driftPpm: number | null;
  windows: number;
  meanScore: number | null;
  method: 'reference' | 'envelope' | 'coarse-only';
}

export const multitrackStage: StageHandler = {
  async run({ job, deps, log, tmpDir }: StageContext) {
    const meeting = await loadMeeting(job.meetingId);
    const session = await SessionModel.findOne({ meetingId: meeting._id });
    if (!session?.startedAt)
      throw new FatalError('No recording session was started for this meeting');
    await SessionModel.updateOne(
      { _id: session._id },
      { $set: { state: 'processing', error: null } },
    );
    const people = (
      await ParticipantModel.find({ sessionId: session._id }).lean<ParticipantDoc[]>()
    ).filter((p) => p.parts.length);
    if (!people.length) throw new FatalError('No phone uploaded any audio');
    const t0 = session.startedAt.getTime();

    // 1. every phone's parts, in order, on the session timeline (coarse alignment)
    const tracks: Float32Array[] = [];
    for (const p of people) {
      const parts = [...p.parts].sort((a, b) => a.index - b.index);
      const decoded: { start: number; pcm: Float32Array }[] = [];
      for (const part of parts) {
        const file = join(tmpDir, `${String(p._id)}-${part.index}`);
        await deps.storage.download(part.url, file);
        decoded.push({
          start: part.startSample,
          pcm: await deps.audio.decodePcm16k(file, `${file}.pcm`),
        });
      }
      const length = Math.max(...decoded.map((d) => d.start + d.pcm.length));
      const phone = new Float32Array(length);
      for (const d of decoded) phone.set(d.pcm, d.start);
      const coarse = ((p.firstSampleServerMs ?? t0) - t0) / 1000;
      tracks.push(placeOnTimeline(phone, coarse));
    }
    const total = Math.max(...tracks.map((t) => t.length));

    // 2. fine alignment against the loudest phone: envelope correlation per 5 minutes, then a drift line
    // the reference is the phone that heard the most speech (not merely the loudest microphone),
    // so every other phone has something to line up with for as long as possible
    const heard = tracks.map((t) => loudnessDb(t).filter((v) => v > -50).length);
    const ref = heard.indexOf(Math.max(...heard));
    const report: TrackReport[] = [];
    const aligned: Float32Array[] = [];
    for (let i = 0; i < people.length; i++) {
      const p = people[i]!;
      const coarseSec = ((p.firstSampleServerMs ?? t0) - t0) / 1000;
      if (i === ref) {
        aligned.push(tracks[i]!);
        report.push({
          name: p.name,
          coarseSec,
          fineSec: 0,
          driftPpm: 0,
          windows: 0,
          meanScore: null,
          method: 'reference',
        });
        continue;
      }
      // 5-minute windows for real meetings; shorter recordings get several so drift can be fitted
      const windowSec = Math.min(300, Math.max(30, Math.floor(total / SR / 6)));
      const pts = offsetsPerWindow(tracks[ref]!, tracks[i]!, {
        expectedOffsetSec: 0,
        searchSec: 20,
        windowSec,
      });
      const fit = fitDrift(pts);
      if (fit && pts.length) {
        aligned.push(alignTrack(tracks[i]!, fit, total));
        report.push({
          name: p.name,
          coarseSec,
          fineSec: Math.round(-fit.a * 1000) / 1000,
          driftPpm: Math.round(fit.b * 1e6),
          windows: pts.length,
          meanScore: Math.round((pts.reduce((s, x) => s + x.score, 0) / pts.length) * 100) / 100,
          method: 'envelope',
        });
      } else {
        aligned.push(tracks[i]!);
        report.push({
          name: p.name,
          coarseSec,
          fineSec: null,
          driftPpm: null,
          windows: 0,
          meanScore: null,
          method: 'coarse-only',
        });
      }
      tracks[i] = new Float32Array(0); // release the unaligned copy
    }

    // 3. best-channel mix, and each phone's loudness for attributing voices later
    const mix = bestChannelMix(aligned);
    await LoudnessModel.deleteMany({ sessionId: session._id });
    for (let i = 0; i < people.length; i++) {
      await LoudnessModel.create({
        sessionId: session._id,
        participantId: people[i]!._id,
        hopSec: 0.25,
        db: Array.from(mix.loudness[i] ?? loudnessDb(aligned[i]!), (v) => Math.round(v * 10) / 10),
      });
    }

    // 4. store the mix as the meeting's recording and run the normal pipeline on it
    const flac = join(tmpDir, 'mix.flac');
    await deps.audio.encodeFlac16k(mix.mix, join(tmpDir, 'mix.pcm'), flac);
    const stored = await deps.storage.uploadAudio(flac, `${session.folder}/mix`);
    await MeetingModel.updateOne(
      { _id: meeting._id },
      {
        $set: {
          'audio.originalUrl': stored.url,
          'audio.originalPublicId': stored.publicId,
          durationSec: Math.round((mix.mix.length / SR) * 10) / 10,
          expectedParticipants: people.length,
          stage: 'ingest',
          status: 'processing',
          error: null,
        },
      },
    );
    await SessionModel.updateOne(
      { _id: session._id },
      {
        $set: {
          state: 'done',
          report: { tracks: report, switches: mix.switches, seconds: total / SR },
        },
      },
    );
    await enqueue({ meetingId: meeting._id, stage: 'ingest' });
    log.info({ phones: people.length, switches: mix.switches, report }, 'phones aligned and mixed');
  },

  async onGiveUp({ job }: StageContext, error: Error) {
    await SessionModel.updateOne(
      { meetingId: job.meetingId },
      { $set: { state: 'failed', error: error.message.slice(0, 300) } },
    );
    await MeetingModel.updateOne(
      { _id: job.meetingId },
      {
        $set: {
          status: 'failed',
          error: {
            stage: 'ingest',
            message: `Combining the phones failed: ${error.message.slice(0, 200)}`,
            retryable: false,
          },
        },
      },
    );
  },
};
