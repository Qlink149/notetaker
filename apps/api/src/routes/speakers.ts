import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { ws } from '../lib/auth.js';
import { HttpError, body, idParam, notFound } from '../lib/http.js';
import { SpeakerModel, type SpeakerDoc } from '../models/index.js';
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
  enrollmentAudioUrl: s.voiceprints.at(-1)?.audioUrl ?? null,
  createdAt: s.createdAt,
});

export function speakersRouter(deps: ApiDeps): Router {
  const r = Router();

  r.get('/speakers', async (req, res) => {
    const list = await SpeakerModel.find({ workspaceId: ws(req)._id })
      .sort({ name: 1 })
      .lean<SpeakerDoc[]>();
    res.json({ speakers: list.map(speakerView) });
  });

  /** Multipart (`name` + `audio` file) or JSON (`name` + `audioUrl` | `trim`). */
  r.post('/speakers/enrol', upload.single('audio'), async (req, res) => {
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
        const up = await deps.storage.uploadAudio(path, id);
        playbackUrl = deps.storage.trimmedWavUrl(up.publicId, 0, 600);
        voiceprintUrl = deps.storage.trimmedWavUrl(up.publicId, 0, MAX_CLIP_SEC);
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
    const result = await SpeakerModel.deleteOne({ _id: idParam(req), workspaceId: ws(req)._id });
    if (!result.deletedCount) throw notFound('speaker_not_found');
    res.status(204).end();
  });

  return r;
}
