import { randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env.js';
import { ws } from '../lib/auth.js';
import { HttpError, body, notFound } from '../lib/http.js';
import { MeetingModel } from '../models/index.js';
import {
  ParticipantModel,
  SessionModel,
  type ParticipantDoc,
  type SessionDoc,
} from '../models/session.js';
import { enqueue } from '../pipeline/queue.js';
import { meetingFolder } from '../services/storage/cloudinary.js';
import type { ApiDeps } from './deps.js';

// PROTOTYPE: group recording from several phones. The host (logged in) creates a session and shows
// its QR; guests open the join page without logging in and are identified only by the token they
// receive when joining. Tested with synthetic tracks, not yet with real phones.

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const code6 = (): string =>
  Array.from(randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

/** A phone may report at most 6 hours of audio (16 kHz): stops absurd values from sizing arrays in the worker. */
const MAX_SAMPLE = 6 * 3600 * 16_000;
const MAX_PARTICIPANTS = 30;

const CreateBody = z.object({ title: z.string().trim().min(1).max(120).optional() });
const JoinBody = z.object({
  name: z.string().trim().min(1).max(60),
  deviceLabel: z.string().trim().max(120).default(''),
  /** A known person, when the host chose one from the speaker list. */
  speakerId: z.string().optional(),
});
const Auth = z.object({ pid: z.string(), token: z.string() });
const HeartbeatBody = Auth.extend({
  level: z.number().min(-120).max(10).nullable().optional(),
  status: z.enum(['ready', 'recording', 'uploaded', 'failed']).optional(),
  /** Phone clock (ms) when it sent this; lets the server estimate the clock difference. */
  clientNowMs: z.number().optional(),
});
const PartBody = Auth.extend({
  index: z.number().int().min(0).max(5000),
  publicId: z.string().min(1),
  url: z.string().url(),
  bytes: z.number().int().min(0),
  /** Index of the part's first sample in the phone's own 16 kHz recording. */
  startSample: z.number().int().min(0).max(MAX_SAMPLE),
  /** The phone's estimate of the server clock (ms) at its very first sample. */
  firstSampleServerMs: z.number().finite().optional(),
});

/** Allow `max` calls per `windowMs` per key (the join endpoint is public). */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string): void => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) throw new HttpError(429, 'Too many attempts. Wait a minute.');
    hits.set(key, [...recent, now]);
  };
}

const hostView = (s: SessionDoc, people: ParticipantDoc[]) => ({
  code: s.code,
  title: s.title,
  state: s.state,
  startedAt: s.startedAt,
  meetingId: s.meetingId ? String(s.meetingId) : null,
  error: s.error,
  report: s.report,
  participants: people.map((p) => ({
    id: String(p._id),
    name: p.name,
    deviceLabel: p.deviceLabel,
    status: p.status,
    level: p.level,
    secondsSinceSeen: Math.round((Date.now() - p.lastSeen.getTime()) / 1000),
    parts: p.parts.length,
    knownSpeaker: Boolean(p.speakerId),
  })),
});

export function sessionsHostRouter(): Router {
  const r = Router();
  const own = async (req: Request): Promise<SessionDoc> => {
    const s = await SessionModel.findOne({
      code: String(req.params.code).toUpperCase(),
      workspaceId: ws(req)._id,
    }).lean<SessionDoc>();
    if (!s) throw notFound('session_not_found');
    return s;
  };
  const view = async (s: SessionDoc) =>
    hostView(
      s,
      await ParticipantModel.find({ sessionId: s._id }).sort({ _id: 1 }).lean<ParticipantDoc[]>(),
    );

  r.post('/sessions', async (req, res) => {
    const { title } = body(CreateBody, req);
    const workspace = ws(req);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = code6();
      try {
        const id = new Types.ObjectId();
        const created = await SessionModel.create({
          _id: id,
          workspaceId: workspace._id,
          code,
          title: title ?? 'Group recording',
          folder: `${meetingFolder(workspace.slug, String(id))}/session`,
        });
        res.status(201).json(await view(created.toObject() as SessionDoc));
        return;
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err; // code clash: try another
      }
    }
    throw new HttpError(500, 'Could not create a session code');
  });

  r.get('/sessions/:code', async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await view(await own(req)));
  });

  r.post('/sessions/:code/start', async (req, res) => {
    const s = await own(req);
    if (s.state !== 'lobby') throw new HttpError(409, `Cannot start a session that is ${s.state}`);
    const ready = await ParticipantModel.countDocuments({ sessionId: s._id });
    if (!ready) throw new HttpError(409, 'Nobody has joined yet');
    await SessionModel.updateOne(
      { _id: s._id },
      { $set: { state: 'recording', startedAt: new Date() } },
    );
    res.json(await view((await SessionModel.findById(s._id).lean<SessionDoc>())!));
  });

  r.post('/sessions/:code/stop', async (req, res) => {
    const s = await own(req);
    if (s.state === 'recording')
      await SessionModel.updateOne(
        { _id: s._id },
        { $set: { state: 'stopped', stoppedAt: new Date() } },
      );
    res.json(await view((await SessionModel.findById(s._id).lean<SessionDoc>())!));
  });

  /** Make the meeting from whatever the phones uploaded and start combining their audio. */
  r.post('/sessions/:code/finish', async (req, res) => {
    const s = await own(req);
    if (s.state !== 'stopped') throw new HttpError(409, 'Stop the recording first');
    const people = await ParticipantModel.find({ sessionId: s._id }).lean<ParticipantDoc[]>();
    const withAudio = people.filter((p) => p.parts.length);
    if (!withAudio.length) throw new HttpError(409, 'No phone has uploaded audio yet');
    // claim the session first, so a double click cannot make two meetings and two jobs
    const claimed = await SessionModel.findOneAndUpdate(
      { _id: s._id, state: 'stopped' },
      { $set: { state: 'processing' } },
    );
    if (!claimed) throw new HttpError(409, 'Already being combined');
    const workspace = ws(req);
    const meeting = await MeetingModel.create({
      workspaceId: workspace._id,
      title: s.title,
      status: 'processing',
      stage: 'ingest',
      engine: workspace.settings.engine,
      languages: workspace.settings.languages,
      expectedParticipants: withAudio.length,
      audio: { originalUrl: 'pending:multitrack', originalPublicId: `${s.folder}/mix` },
    });
    await SessionModel.updateOne(
      { _id: s._id },
      { $set: { state: 'processing', meetingId: meeting._id } },
    );
    await enqueue({ meetingId: meeting._id, stage: 'multitrack' });
    res.status(202).json(await view((await SessionModel.findById(s._id).lean<SessionDoc>())!));
  });

  return r;
}

export function sessionsGuestRouter(deps: ApiDeps): Router {
  const r = Router();
  const joinLimit = limiter(100, 60_000); // a room of phones shares one address
  // every guest call is throttled per address and code (phones poll every 2 s; a room shares one address)
  const callLimit = limiter(1500, 60_000);

  const live = async (req: Request): Promise<SessionDoc> => {
    callLimit(`${req.ip ?? 'unknown'}:${String(req.params.code)}`);
    const s = await SessionModel.findOne({
      code: String(req.params.code).toUpperCase(),
    }).lean<SessionDoc>();
    if (!s) throw notFound('session_not_found');
    return s;
  };
  const participant = async (s: SessionDoc, a: z.infer<typeof Auth>): Promise<ParticipantDoc> => {
    if (!Types.ObjectId.isValid(a.pid)) throw new HttpError(401, 'unknown_participant');
    const p = await ParticipantModel.findOne({
      _id: a.pid,
      sessionId: s._id,
    }).lean<ParticipantDoc>();
    if (!p || p.token !== a.token) throw new HttpError(401, 'unknown_participant');
    return p;
  };
  /** Signatures and parts are accepted until the host combines the audio. */
  const uploadsOpen = (s: SessionDoc): void => {
    if (!['lobby', 'recording', 'stopped'].includes(s.state))
      throw new HttpError(409, 'This recording is closed.');
  };
  const stateOf = (s: SessionDoc) => ({
    state: s.state,
    title: s.title,
    startedAtServerMs: s.startedAt?.getTime() ?? null,
    serverNowMs: Date.now(),
  });

  r.post('/join/:code', async (req, res) => {
    joinLimit(req.ip ?? 'unknown');
    const s = await live(req);
    if (s.state !== 'lobby' && s.state !== 'recording')
      throw new HttpError(409, 'This recording is no longer open to join.');
    const input = body(JoinBody, req);
    if ((await ParticipantModel.countDocuments({ sessionId: s._id })) >= MAX_PARTICIPANTS)
      throw new HttpError(409, 'This recording is full.');
    const p = await ParticipantModel.create({
      sessionId: s._id,
      name: input.name,
      deviceLabel: input.deviceLabel,
      token: randomBytes(18).toString('hex'),
      speakerId:
        input.speakerId && Types.ObjectId.isValid(input.speakerId)
          ? new Types.ObjectId(input.speakerId)
          : null,
    });
    res.status(201).json({ participantId: String(p._id), token: p.token, ...stateOf(s) });
  });

  /** Polled by every phone every 2 s: tells it whether to record, and reports its level. */
  r.post('/join/:code/heartbeat', async (req, res) => {
    const s = await live(req);
    const input = body(HeartbeatBody, req);
    await participant(s, input);
    await ParticipantModel.updateOne(
      { _id: input.pid },
      {
        $set: {
          lastSeen: new Date(),
          ...(input.level !== undefined ? { level: input.level } : {}),
          ...(input.status ? { status: input.status } : {}),
        },
      },
    );
    res.set('Cache-Control', 'no-store').json(stateOf(s));
  });

  /** Signed upload into this session's folder (the phone uploads straight to storage). */
  r.post('/join/:code/sign', async (req, res) => {
    const s = await live(req);
    const input = body(Auth, req);
    await participant(s, input);
    uploadsOpen(s);
    res.json(deps.storage.signUpload(`${s.folder}/${input.pid}`));
  });

  r.post('/join/:code/parts', async (req, res) => {
    const s = await live(req);
    const input = body(PartBody, req);
    await participant(s, input);
    uploadsOpen(s);
    if (!input.publicId.startsWith(`${s.folder}/${input.pid}/`))
      throw new HttpError(400, "publicId is not in this phone's folder");
    // the worker downloads this address: it must be the stored file itself, not an arbitrary address
    let host: URL | null = null;
    try {
      host = new URL(input.url);
    } catch {
      host = null;
    }
    const cloud = env().CLOUDINARY_CLOUD_NAME;
    if (
      !host ||
      host.protocol !== 'https:' ||
      !input.url.includes(input.publicId) ||
      (cloud && !host.pathname.startsWith(`/${cloud}/`))
    )
      throw new HttpError(400, 'url must be the uploaded file');
    // the phone's clock estimate may differ from the host's Start by seconds, not hours
    if (
      input.firstSampleServerMs !== undefined &&
      s.startedAt &&
      Math.abs(input.firstSampleServerMs - s.startedAt.getTime()) > 10 * 60_000
    )
      throw new HttpError(400, 'firstSampleServerMs is not close to the start of the recording');
    // a part can be re-sent after a bad connection: replace by index
    await ParticipantModel.updateOne(
      { _id: input.pid },
      { $pull: { parts: { index: input.index } } },
    );
    await ParticipantModel.updateOne(
      { _id: input.pid },
      {
        $push: {
          parts: {
            index: input.index,
            publicId: input.publicId,
            url: input.url,
            bytes: input.bytes,
            startSample: input.startSample,
          },
        },
        $set: { lastSeen: new Date() },
      },
    );
    // the time of the phone's very first sample can be worked out from any part
    if (input.firstSampleServerMs !== undefined) {
      await ParticipantModel.updateOne(
        { _id: input.pid, firstSampleServerMs: null },
        {
          $set: {
            firstSampleServerMs: input.firstSampleServerMs - (input.startSample / 16_000) * 1000,
          },
        },
      );
    }
    res.json({ ok: true });
  });

  return r;
}
