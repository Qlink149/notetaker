import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router, type Request } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../config/env.js';
import { playableUrl } from '../lib/audioLink.js';
import { ws } from '../lib/auth.js';
import { cutFlac, toAnalysisFlac } from '../services/audio/ffmpeg.js';
import { HttpError, body, idParam, notFound } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { playbackUrlOf } from '../lib/views.js';
import { MeetingDataModel, MeetingModel, SpeakerModel, type SpeakerDoc } from '../models/index.js';
import { isUsableSample } from '../services/identity/enroll.js';
import { isActiveSample, mainSample, sampleKey } from '../services/identity/samples.js';
import type { ApiDeps } from './deps.js';

// Ported from legacy/base44/functions/enrollSpeaker. Phase 1 keeps the Speakers page working;
// voiceprints are not used by the pipeline until Phase 2.

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const MIN_CLIP_SEC = 3;
const MAX_CLIP_SEC = 30;

const EnrolBody = z.object({
  name: z.string().trim().min(1).max(100),
  audioUrl: z.string().url().optional(),
  trim: z
    .object({ publicId: z.string().min(1), start: z.number().min(0), end: z.number() })
    .optional(),
});

const RemoveSampleBody = z.object({ ignoreMeeting: z.boolean().optional() });

/** Samples still compared with new voices; a removed one is kept on the profile but does not count. */
const active = (s: SpeakerDoc) => s.voiceprints.filter(isActiveSample);

const speakerView = (s: SpeakerDoc) => ({
  id: String(s._id),
  name: s.name,
  hasVoiceprint: active(s).length > 0,
  voiceprintCount: active(s).length,
  anonymous: s.anonymous ?? false,
  enrollmentAudioUrl: playableUrl(active(s).at(-1)?.audioUrl) ?? null,
  createdAt: s.createdAt,
});

/**
 * Every voice sample saved for one person, removed ones included and flagged, each with the recording it was cut
 * from and where, so it can be played. `key` names a sample in the remove and restore calls; the voiceprint and
 * the sample's own id never leave the server. `meetingConfirmed`: a person confirmed a voice of that meeting as
 * this person, so a wrong sample is probably a wrong card there, and other clips of it would follow.
 */
async function samplesOf(person: SpeakerDoc, workspaceId: SpeakerDoc['workspaceId']) {
  const meetingIds = [
    ...new Set(
      person.voiceprints
        .map((v) => v.meetingId)
        .filter((id): id is NonNullable<typeof id> => !!id)
        .map(String),
    ),
  ];
  const [meetings, data] = await Promise.all([
    MeetingModel.find({ _id: { $in: meetingIds }, workspaceId }).lean(),
    MeetingDataModel.find(
      { meetingId: { $in: meetingIds } },
      { meetingId: 1, speakerCards: 1 },
    ).lean(),
  ]);
  const byId = new Map(meetings.map((m) => [String(m._id), m]));
  const confirmedIn = new Set(
    data
      .filter((d) =>
        (d.speakerCards ?? []).some(
          (c) => c.confirmed === true && c.personId === String(person._id),
        ),
      )
      .map((d) => String(d.meetingId)),
  );
  const main = mainSample(
    person.voiceprints.filter(isUsableSample),
    person.mainSampleId,
    new Set(byId.keys()),
  );
  return person.voiceprints.map((v, i) => {
    const meeting = v.meetingId ? byId.get(String(v.meetingId)) : undefined;
    const clip = v.clip && v.clip.end > v.clip.start ? v.clip : null;
    // a clip cut from a meeting plays from that meeting's recording; a recorded sample from its own file
    const url = meeting && clip ? playbackUrlOf(meeting) : playableUrl(v.audioUrl) || null;
    return {
      index: i,
      key: sampleKey(v),
      removed: !isActiveSample(v),
      main: v === main,
      source: v.source,
      createdAt: v.createdAt,
      meetingId: meeting ? String(meeting._id) : null,
      meetingTitle: meeting?.title ?? null,
      meetingConfirmed: meeting ? confirmedIn.has(String(meeting._id)) : false,
      start: meeting && clip ? clip.start : 0,
      end: meeting && clip ? clip.end : (clip?.end ?? null),
      seconds: clip ? Math.round((clip.end - clip.start) * 10) / 10 : null,
      audioUrl: url,
    };
  });
}

export function speakersRouter(deps: ApiDeps): Router {
  const r = Router();

  const personOf = async (req: Request): Promise<SpeakerDoc> => {
    const person = await SpeakerModel.findOne({
      _id: idParam(req),
      workspaceId: ws(req)._id,
    }).lean<SpeakerDoc>();
    if (!person) throw notFound('speaker_not_found');
    return person;
  };

  r.get('/speakers', async (req, res) => {
    const list = await SpeakerModel.find({ workspaceId: ws(req)._id })
      .sort({ name: 1 })
      .lean<SpeakerDoc[]>();
    res.json({ speakers: list.map(speakerView) });
  });

  /** Every voice sample saved for a person, playable (28 Oct: a profile that holds two people can only be heard). */
  r.get('/speakers/:id/samples', async (req, res) => {
    const person = await personOf(req);
    res.json({ name: person.name, samples: await samplesOf(person, ws(req)._id) });
  });

  /**
   * Take one sample off a person. It stays on the profile, flagged, so it is not learned again from the same
   * meeting and the positions that name the labels of earlier identify jobs do not move; restoring clears it.
   * `ignoreMeeting` also removes that person's other samples from the same meeting and stops learning from it.
   */
  r.post('/speakers/:id/samples/:key/remove', async (req, res) => {
    const { ignoreMeeting } = body(RemoveSampleBody, req);
    const person = await personOf(req);
    const sample = person.voiceprints.find((v) => sampleKey(v) === String(req.params.key));
    if (!sample) throw notFound('sample_not_found');
    const meetingId = sample.meetingId ?? null;
    const wide = Boolean(ignoreMeeting && meetingId);
    const ids = person.voiceprints
      .filter(
        (v) =>
          isActiveSample(v) &&
          (v === sample || (wide && v.meetingId && String(v.meetingId) === String(meetingId))),
      )
      .map((v) => v.id);
    await SpeakerModel.updateOne(
      { _id: person._id },
      {
        $set: { 'voiceprints.$[v].removedAt': new Date() },
        ...(wide ? { $addToSet: { ignoreMeetings: meetingId } } : {}),
      },
      { arrayFilters: [{ 'v.id': { $in: ids }, 'v.removedAt': null }] },
    );
    logger.info(
      {
        person: String(person._id),
        meeting: String(meetingId),
        clipStart: sample.clip?.start,
        wide,
      },
      'voice sample removed',
    );
    const fresh = await personOf(req);
    res.json({ name: fresh.name, samples: await samplesOf(fresh, ws(req)._id) });
  });

  /**
   * Make this the one sample new voices are compared with (28 Oct). The others stay as spares. Not for a removed
   * sample, nor for one pyannote cannot compare with.
   */
  r.post('/speakers/:id/samples/:key/main', async (req, res) => {
    const person = await personOf(req);
    const sample = person.voiceprints.find((v) => sampleKey(v) === String(req.params.key));
    if (!sample) throw notFound('sample_not_found');
    if (!isActiveSample(sample) || !isUsableSample(sample))
      throw new HttpError(409, 'That sample cannot be used: restore it first.');
    await SpeakerModel.updateOne({ _id: person._id }, { $set: { mainSampleId: sample.id } });
    logger.info(
      { person: String(person._id), meeting: String(sample.meetingId), clipStart: sample.clip?.start },
      'main voice sample changed',
    );
    const fresh = await personOf(req);
    res.json({ name: fresh.name, samples: await samplesOf(fresh, ws(req)._id) });
  });

  /** Put a removed sample back. If its meeting was ignored, learning from that meeting is allowed again. */
  r.post('/speakers/:id/samples/:key/restore', async (req, res) => {
    const person = await personOf(req);
    const sample = person.voiceprints.find((v) => sampleKey(v) === String(req.params.key));
    if (!sample) throw notFound('sample_not_found');
    await SpeakerModel.updateOne(
      { _id: person._id },
      {
        $set: { 'voiceprints.$[v].removedAt': null },
        ...(sample.meetingId ? { $pull: { ignoreMeetings: sample.meetingId } } : {}),
      },
      { arrayFilters: [{ 'v.id': sample.id }] },
    );
    logger.info(
      {
        person: String(person._id),
        meeting: String(sample.meetingId),
        clipStart: sample.clip?.start,
      },
      'voice sample restored',
    );
    const fresh = await personOf(req);
    res.json({ name: fresh.name, samples: await samplesOf(fresh, ws(req)._id) });
  });

  /** Multipart (`name` + `audio` file) or JSON (`name` + `audioUrl` | `trim`). */
  r.post('/speakers/enrol', upload.single('audio'), async (req, res) => {
    if (!env().PYANNOTEAI_API_KEY) {
      throw new HttpError(503, 'Speaker enrolment is disabled: PYANNOTEAI_API_KEY is not set');
    }
    const workspace = ws(req);
    const input = body(EnrolBody, {
      ...req,
      body: {
        ...req.body,
        ...(typeof req.body?.trim === 'string'
          ? { trim: JSON.parse(req.body.trim as string) }
          : {}),
      },
    } as never);
    if (await SpeakerModel.exists({ workspaceId: workspace._id, name: input.name })) {
      throw new HttpError(409, `A speaker named "${input.name}" already exists.`);
    }

    let playbackUrl: string;
    let voiceprintUrl: string;
    if (input.trim) {
      const len = input.trim.end - input.trim.start;
      if (len > MAX_CLIP_SEC)
        throw new HttpError(
          400,
          'Clip is too long for a voiceprint (max 30 seconds). Pick a shorter segment.',
        );
      if (len < MIN_CLIP_SEC)
        throw new HttpError(400, 'Clip is too short for a voiceprint (min 3 seconds).');
      playbackUrl = voiceprintUrl = deps.storage.trimmedWavUrl(
        input.trim.publicId,
        input.trim.start,
        input.trim.end,
      );
    } else if (req.file) {
      const dir = await mkdtemp(join(tmpdir(), 'enrol-'));
      try {
        const path = join(dir, 'clip');
        await writeFile(path, req.file.buffer);
        const id = `workspaces/${workspace.slug}/speakers/voiceprint-${Date.now()}-${randomBytes(3).toString('hex')}`;
        if (deps.storage.trimsRemotely) {
          const up = await deps.storage.uploadAudio(path, id);
          playbackUrl = deps.storage.trimmedWavUrl(up.publicId, 0, 600);
          voiceprintUrl = deps.storage.trimmedWavUrl(up.publicId, 0, MAX_CLIP_SEC);
        } else {
          // private storage cannot cut a clip: keep the first 30 s ourselves, then hand pyannote a
          // short-lived link and the app a signed playback link
          // convert first (it repairs iPhone Safari recordings the cutter would thin out), then cut the clip
          const flac = join(dir, 'analysis.flac');
          await toAnalysisFlac(path, flac);
          const clip = join(dir, 'clip.flac');
          await cutFlac(flac, clip, 0, MAX_CLIP_SEC);
          const up = await deps.storage.uploadAudio(clip, id);
          voiceprintUrl = await deps.storage.presignGet!(up.publicId, 3600);
          playbackUrl = `b2://${up.publicId}`; // shown through a signed link (playableUrl)
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } else if (input.audioUrl) {
      playbackUrl = voiceprintUrl = input.audioUrl;
    } else {
      throw new HttpError(400, 'Provide an audio file, audioUrl or trim');
    }

    let voiceprint: string;
    try {
      voiceprint = await deps.createVoiceprint(voiceprintUrl);
    } catch (err) {
      throw new HttpError(502, `pyannote voiceprint create failed: ${(err as Error).message}`);
    }
    const speaker = await SpeakerModel.create({
      workspaceId: workspace._id,
      name: input.name,
      voiceprints: [{ id: voiceprint, source: 'enrolment', audioUrl: playbackUrl }],
    });
    res.status(201).json({ speaker: speakerView(speaker.toObject() as SpeakerDoc) });
  });

  r.delete('/speakers/:id', async (req, res) => {
    const id = idParam(req);
    const result = await SpeakerModel.deleteOne({ _id: id, workspaceId: ws(req)._id });
    if (!result.deletedCount) throw notFound('speaker_not_found');
    // no meeting card may keep pointing at a person who no longer exists
    await MeetingDataModel.updateMany(
      { 'speakerCards.personId': String(id) },
      { $set: { 'speakerCards.$[c].personId': null, 'speakerCards.$[c].match': null } },
      { arrayFilters: [{ 'c.personId': String(id) }] },
    );
    res.status(204).end();
  });

  return r;
}
