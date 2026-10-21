import { Router } from 'express';
import { Types } from 'mongoose';
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
  readState,
  revoke,
  saveDoc,
  sealToken,
  signState,
  webAppUrl,
} from '../services/google/drive.js';
import { driveDocument } from '../services/google/driveDocument.js';

const status = (w: WorkspaceDoc): DriveStatus => ({
  available: driveAvailable(),
  connected: Boolean(w.google?.refreshTokenEnc),
  email: w.google?.email ?? null,
});

/** Google sends the browser back here after consent; it carries no login, only the state we signed. */
export function googleCallbackRouter(): Router {
  const r = Router();
  r.get('/integrations/google/callback', async (req, res) => {
    const back = (result: string) => res.redirect(`${webAppUrl()}/settings?drive=${result}`);
    const workspaceId = readState(String(req.query.state ?? ''));
    if (!workspaceId || !driveAvailable()) return back('failed');
    if (req.query.error || !req.query.code) return back('cancelled');
    try {
      const { refreshToken, email } = await exchangeCode(String(req.query.code));
      await WorkspaceModel.updateOne(
        { _id: new Types.ObjectId(workspaceId) },
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

  r.post('/integrations/google/start', (req, res) => {
    if (!driveAvailable()) throw new HttpError(503, 'drive_not_configured');
    res.json({ url: authUrl(signState(String(ws(req)._id))) });
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
      // the person removed the app's access in their Google account: ask them to connect again
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
