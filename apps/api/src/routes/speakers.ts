import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../config/env.js';
import { playableUrl } from '../lib/audioLink.js';
import { ws } from '../lib/auth.js';
import { cutFlac, toAnalysisFlac } from '../services/audio/ffmpeg.js';
import { HttpError, body, idParam, notFound } from '../lib/http.js';
import { assertSpeakerAdmin, speakerAdmin } from '../lib/speakerAccess.js';
import { MeetingDataModel, SpeakerModel, type SpeakerDoc } from '../models/index.js';
import {
  EditError,
  NameExistsError,
  UndoError,
  assignVoice,
  listOpenUndos,
  markPersonLeft,
  undoAssign,
} from '../services/identity/assign.js';
import { applyNames, meetingsOfPerson } from '../services/identity/identity.js';
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

const speakerView = (s: SpeakerDoc) => ({
  id: String(s._id),
  name: s.name,
  hasVoiceprint: s.voiceprints.length > 0,
  voiceprintCount: s.voiceprints.length,
  anonymous: s.anonymous ?? false,
  email: s.email ?? null,
  role: s.role ?? null,
  leftAt: s.leftAt ? new Date(s.leftAt).toISOString() : null,
  enrollmentAudioUrl: playableUrl(s.voiceprints.at(-1)?.audioUrl) ?? null,
  createdAt: s.createdAt,
});

const AssignBody = z.object({
  personId: z.string().optional(),
  name: z.string().max(200).optional(),
  confirm: z.boolean().optional(),
});

function asHttp(err: unknown): never {
  if (err instanceof EditError) throw new HttpError(400, err.message);
  if (err instanceof UndoError) throw new HttpError(err.status, err.message);
  throw err;
}

export function speakersRouter(deps: ApiDeps): Router {
  const r = Router();

  r.get('/speakers', async (req, res) => {
    const workspace = ws(req);
    const { allowed } = await speakerAdmin(workspace);
    const list = await SpeakerModel.find({ workspaceId: workspace._id })
      .sort({ name: 1 })
      .lean<SpeakerDoc[]>();
    res.json({
      speakers: list.map(speakerView),
      canAssignSpeakers: allowed,
      undos: allowed ? await listOpenUndos(String(workspace._id)) : [],
    });
  });

  /**
   * Merge this voice into a person (`personId`) or give it a new name (`name`).
   * Writes only when `confirm` is true. A name that already exists answers 409 with those people
   * so the caller can merge into one of them instead. Admin allowlist only.
   */
  r.post('/speakers/:id/assign', async (req, res) => {
    await assertSpeakerAdmin(ws(req));
    const input = body(AssignBody, req);
    try {
      const result = await assignVoice(String(ws(req)._id), String(idParam(req)), input);
      res.json(result);
    } catch (err) {
      if (err instanceof NameExistsError) {
        res.status(409).json({ error: 'name_exists', matches: err.matches });
        return;
      }
      asHttp(err);
    }
  });

  /** Keep this person's name on past meetings, and stop matching their voice in new ones. */
  r.post('/speakers/:id/leave', async (req, res) => {
    await assertSpeakerAdmin(ws(req));
    try {
      const leftAt = await markPersonLeft(String(ws(req)._id), String(idParam(req)));
      res.json({ leftAt: leftAt.toISOString() });
    } catch (err) {
      asHttp(err);
    }
  });

  /** Undo a merge or rename from the last SPEAKER_UNDO_MINUTES. */
  r.post('/speakers/undo/:undoId', async (req, res) => {
    await assertSpeakerAdmin(ws(req));
    const undoId = req.params.undoId;
    if (typeof undoId !== 'string') throw notFound('undo_not_found');
    try {
      await undoAssign(String(ws(req)._id), undoId);
      res.json({ restored: true });
    } catch (err) {
      asHttp(err);
    }
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
    const person = await SpeakerModel.findOne({ _id: id, workspaceId: ws(req)._id }).lean();
    if (!person) throw notFound('speaker_not_found');
    const meetings = await meetingsOfPerson(String(id));
    // The card must not keep a dangling person. voiceDeleted makes old lines say "Unknown speaker".
    await MeetingDataModel.updateMany(
      { 'speakerCards.personId': String(id) },
      {
        $set: {
          'speakerCards.$[c].personId': null,
          'speakerCards.$[c].match': null,
          'speakerCards.$[c].voiceDeleted': true,
        },
      },
      { arrayFilters: [{ 'c.personId': String(id) }] },
    );
    await SpeakerModel.deleteOne({ _id: id });
    for (const meetingId of meetings) await applyNames(meetingId);
    res.status(204).end();
  });

  return r;
}
