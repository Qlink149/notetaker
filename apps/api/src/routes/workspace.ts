import { Router } from 'express';
import { z } from 'zod';
import { Glossary, LoginBody, WorkspaceSettings } from '@meetingid/shared';
import {
  TOKEN_COOKIE,
  hashAccessCode,
  issueToken,
  requireAuth,
  workspaceForCode,
  ws,
} from '../lib/auth.js';
import { HttpError, assertEngineEnabled, body } from '../lib/http.js';
import { workspaceView } from '../lib/views.js';
import { GlossaryModel, WorkspaceModel, type WorkspaceDoc } from '../models/index.js';

/** Per-IP throttle on failed logins: 10 failures per 15 minutes, then 429 until the window ends. */
const failures = new Map<string, { count: number; resetAt: number }>();
function checkThrottle(ip: string): void {
  const f = failures.get(ip);
  if (f && f.resetAt > Date.now() && f.count >= 10) throw new HttpError(429, 'too_many_attempts');
}
function recordFailure(ip: string): void {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || f.resetAt < now) failures.set(ip, { count: 1, resetAt: now + 15 * 60_000 });
  else f.count++;
}

export function authRouter(): Router {
  const r = Router();
  r.post('/auth/login', async (req, res) => {
    const ip = req.ip ?? 'unknown';
    checkThrottle(ip);
    const { code } = body(LoginBody, req);
    const workspace = await workspaceForCode(code);
    if (!workspace) {
      recordFailure(ip);
      throw new HttpError(401, 'invalid_code');
    }
    const token = issueToken(workspace);
    res.cookie(TOKEN_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 30 * 24 * 3600_000,
    });
    res.json({ token, workspace: workspaceView(workspace) });
  });
  r.post('/auth/logout', (_req, res) => {
    res.clearCookie(TOKEN_COOKIE).status(204).end();
  });
  return r;
}

export function workspaceRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  r.get('/auth/me', (req, res) => {
    res.json({ workspace: workspaceView(ws(req)) });
  });

  r.get('/workspace/settings', (req, res) => {
    res.json({ settings: ws(req).settings });
  });

  r.put('/workspace/settings', async (req, res) => {
    const settings = body(WorkspaceSettings, req);
    await assertEngineEnabled([settings.engine]);
    const updated = await WorkspaceModel.findByIdAndUpdate(
      ws(req)._id,
      { $set: { settings } },
      { returnDocument: 'after' },
    ).lean<WorkspaceDoc>();
    res.json({ settings: updated!.settings });
  });

  /** Rotate the shared access code; every existing token stops working. */
  r.post('/workspace/access-code', async (req, res) => {
    const { code } = body(z.object({ code: z.string().min(8).max(200) }), req);
    const updated = await WorkspaceModel.findByIdAndUpdate(
      ws(req)._id,
      { $set: { accessCodeHash: hashAccessCode(code) }, $inc: { tokenVersion: 1 } },
      { returnDocument: 'after' },
    ).lean<WorkspaceDoc>();
    res.json({ token: issueToken(updated!) });
  });

  r.get('/glossary', async (req, res) => {
    const g = await GlossaryModel.findOne({ workspaceId: ws(req)._id }).lean();
    res.json({ entries: g?.entries ?? [] });
  });

  r.put('/glossary', async (req, res) => {
    const { entries } = body(Glossary, req);
    const g = await GlossaryModel.findOneAndUpdate(
      { workspaceId: ws(req)._id },
      { $set: { entries } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
    res.json({ entries: g?.entries ?? [] });
  });

  return r;
}
