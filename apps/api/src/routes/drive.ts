import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { FoldersBody, type DriveStatus } from '@meetingid/shared';
import { ws } from '../lib/auth.js';
import { HttpError, body, idParam, notFound } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { foldersOf, meetingView } from '../lib/views.js';
import {
  MeetingDataModel,
  MeetingModel,
  WorkspaceModel,
  type MeetingDoc,
  type WorkspaceDoc,
} from '../models/index.js';
import {
  GoogleError,
  ROOT_FOLDER,
  accessToken,
  authUrl,
  driveAvailable,
  ensureFolder,
  exchangeCode,
  meetingReturnPath,
  parseReturnTo,
  readState,
  revoke,
  saveDoc,
  sealToken,
  signState,
  webAppUrl,
  type DriveReturn,
} from '../services/google/drive.js';
import { driveDocument } from '../services/google/driveDocument.js';

const status = (w: WorkspaceDoc): DriveStatus => ({
  available: driveAvailable(),
  connected: Boolean(w.google?.refreshTokenEnc),
  email: w.google?.email ?? null,
});

type ConnectResult = 'connected' | 'cancelled' | 'failed' | 'no-permission';

/** Settings when nothing asked to come back; otherwise this meeting, with a flag we choose. */
function redirectAfter(result: ConnectResult, returnTo: DriveReturn | null): string {
  const base = webAppUrl();
  if (!returnTo) return `${base}/settings?drive=${result}`;
  const flag = result === 'connected' ? 'save' : result;
  return `${base}${meetingReturnPath(returnTo.meetingId, flag)}`;
}

/** Google sends the browser back here after consent; it carries no login, only the state we signed. */
export function googleCallbackRouter(): Router {
  const r = Router();
  r.get('/integrations/google/callback', async (req, res) => {
    const parsed = readState(String(req.query.state ?? ''));
    const back = (result: ConnectResult) =>
      res.redirect(redirectAfter(result, parsed?.returnTo ?? null));
    if (!parsed || !driveAvailable()) return back('failed');
    if (req.query.error || !req.query.code) return back('cancelled');
    try {
      const { refreshToken, email } = await exchangeCode(String(req.query.code));
      await WorkspaceModel.updateOne(
        { _id: new Types.ObjectId(parsed.workspaceId) },
        {
          $set: {
            google: {
              refreshTokenEnc: sealToken(refreshToken),
              email,
              connectedAt: new Date(),
              rootFolderId: null,
              folderIds: {},
            },
          },
        },
      );
      back('connected');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'google connect failed');
      back(err instanceof GoogleError && err.status === 403 ? 'no-permission' : 'failed');
    }
  });
  return r;
}

/** Folders for meetings, the Google Drive connection, and "Save to Drive". */
export function driveRouter(): Router {
  const r = Router();

  r.put('/workspace/folders', async (req, res) => {
    const { folders } = body(FoldersBody, req);
    const clean = [...new Set(folders.map((f) => f.trim()).filter(Boolean))];
    await WorkspaceModel.updateOne({ _id: ws(req)._id }, { $set: { folders: clean } });
    res.json({ folders: clean });
  });

  r.get('/integrations/google', (req, res) => {
    res.set('Cache-Control', 'no-store').json(status(ws(req)));
  });

  const GoogleStartBody = z.object({
    returnTo: z
      .union([
        z.string().max(200),
        z.object({
          meetingId: z.string().max(200),
          folder: z.string().max(200).nullable().optional(),
        }),
      ])
      .optional(),
  });

  r.post('/integrations/google/start', (req, res) => {
    if (!driveAvailable()) throw new HttpError(503, 'drive_not_configured');
    const { returnTo } = body(GoogleStartBody, req);
    let dest: DriveReturn | null = null;
    if (returnTo !== undefined) {
      const parsed = parseReturnTo(returnTo);
      if (!parsed) throw new HttpError(400, 'invalid_request');
      dest = parsed;
    }
    res.json({ url: authUrl(signState(String(ws(req)._id), Date.now(), dest)) });
  });

  r.delete('/integrations/google', async (req, res) => {
    const g = ws(req).google;
    if (g?.refreshTokenEnc) await revoke(g.refreshTokenEnc);
    await WorkspaceModel.updateOne({ _id: ws(req)._id }, { $set: { google: null } });
    res.status(204).end();
  });

  /**
   * Save the meeting as a Google Doc in `MeetingID/<its folder>`; pressing it again updates the same Doc (and
   * moves it when the meeting changed folder).
   */
  r.post('/meetings/:id/drive', async (req, res) => {
    const w = ws(req);
    const m = await MeetingModel.findOne({
      _id: idParam(req),
      workspaceId: w._id,
    }).lean<MeetingDoc>();
    if (!m) throw notFound('meeting_not_found');
    if (!driveAvailable()) throw new HttpError(503, 'drive_not_configured');
    const g = w.google;
    if (!g?.refreshTokenEnc) throw new HttpError(409, 'drive_not_connected');
    const data = await MeetingDataModel.findOne({ meetingId: m._id }, { lines: 1 }).lean();
    if (!data?.lines.length) throw new HttpError(409, 'transcript_not_ready');

    let token: string;
    try {
      token = await accessToken(g.refreshTokenEnc);
    } catch (err) {
      // the stored sign-in can no longer be used: the meeting's Save button connects again in the same tap
      if (err instanceof GoogleError && (err.status === 400 || err.status === 401)) {
        await WorkspaceModel.updateOne({ _id: w._id }, { $set: { google: null } });
        throw new HttpError(409, 'drive_reconnect');
      }
      throw err;
    }
    const folder = m.folder && foldersOf(w).includes(m.folder) ? m.folder : null;
    const rootId = await ensureFolder(token, ROOT_FOLDER, null, g.rootFolderId);
    const folderIds = { ...(rootId === g.rootFolderId ? g.folderIds : {}) };
    const parent = folder
      ? await ensureFolder(token, folder, rootId, folderIds[folder] ?? null)
      : rootId;
    if (folder) folderIds[folder] = parent;
    await WorkspaceModel.updateOne(
      { _id: w._id },
      { $set: { 'google.rootFolderId': rootId, 'google.folderIds': folderIds } },
    );

    const doc = await driveDocument(m, data);
    const saved = await saveDoc(token, {
      fileId: m.drive?.fileId ?? null,
      name: doc.name,
      folderId: parent,
      docx: doc.docx,
    });
    const updated = await MeetingModel.findByIdAndUpdate(
      m._id,
      { $set: { drive: { ...saved, folder, savedAt: new Date() } } },
      { returnDocument: 'after' },
    ).lean<MeetingDoc>();
    res.json({ meeting: meetingView(updated!) });
  });

  return r;
}
