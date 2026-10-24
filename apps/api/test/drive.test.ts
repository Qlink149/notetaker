import { createHmac, hkdfSync } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { env, resetEnvCache } from '../src/config/env.js';
import {
  MeetingDataModel,
  MeetingModel,
  WorkspaceModel,
  type WorkspaceDoc,
} from '../src/models/index.js';
import {
  meetingReturnPath,
  openToken,
  parseReturnTo,
  readState,
  setGoogleFetch,
  signState,
} from '../src/services/google/drive.js';
import { ACCESS_CODE, clearDb, fakeStorage, seedWorkspace, startDb, stopDb } from './helpers.js';

let app: Express;
let workspace: WorkspaceDoc;
let token: string;

/** A stand-in for Google: OAuth, userinfo and Drive files, recording every call. */
function fakeGoogle() {
  const calls: { method: string; url: string; body: string }[] = [];
  const files = new Map<string, { parents: string[]; trashed?: boolean }>();
  let n = 0;
  let refreshBroken = false;
  const reply = (status: number, body: object) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = init.body instanceof Buffer ? init.body.toString('utf8') : String(init.body ?? '');
    calls.push({ method, url, body });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      if (body.includes('grant_type=authorization_code'))
        return reply(200, {
          access_token: 'at-1',
          refresh_token: 'rt-secret',
          scope: 'openid email https://www.googleapis.com/auth/drive.file',
        });
      if (refreshBroken) return reply(400, { error: 'invalid_grant' });
      return reply(200, { access_token: 'at-2' });
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return reply(200, {});
    if (url.includes('userinfo')) return reply(200, { email: 'heet@kisna.in' });
    const get = /drive\/v3\/files\/([^?]+)\?fields/.exec(url);
    if (get && method === 'GET') {
      const f = files.get(get[1]!);
      return f ? reply(200, { id: get[1], ...f }) : reply(404, {});
    }
    if (url.startsWith('https://www.googleapis.com/drive/v3/files?') && method === 'POST') {
      const meta = JSON.parse(body) as { parents?: string[] };
      const id = `folder-${++n}`;
      files.set(id, { parents: meta.parents ?? [] });
      return reply(200, { id });
    }
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?') && method === 'POST') {
      const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n/s.exec(body)![1]!) as { parents: string[] };
      const id = `doc-${++n}`;
      files.set(id, { parents: meta.parents });
      return reply(200, { id, webViewLink: `https://docs.google.com/document/d/${id}/edit` });
    }
    const patch = /upload\/drive\/v3\/files\/([^?]+)\?(.*)$/.exec(url);
    if (patch && method === 'PATCH') {
      const q = new URLSearchParams(patch[2]);
      const f = files.get(patch[1]!)!;
      if (q.get('addParents')) f.parents = [q.get('addParents')!];
      return reply(200, {
        id: patch[1],
        webViewLink: `https://docs.google.com/document/d/${patch[1]}/edit`,
      });
    }
    return reply(500, { error: `unexpected ${method} ${url}` });
  };
  return {
    calls,
    files,
    fetch: fetch as typeof globalThis.fetch,
    breakRefresh: () => (refreshBroken = true),
  };
}

let google: ReturnType<typeof fakeGoogle>;

beforeAll(async () => {
  await startDb();
  app = createApp({
    storage: await fakeStorage(),
    geminiFiles: {
      upload: async () => ({ uri: 'u', name: 'n', mimeType: 'audio/flac', keyId: 'k1' }),
      delete: async () => undefined,
    },
    createVoiceprint: async () => 'vp',
  });
});
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    PUBLIC_API_URL: 'https://api.meetingid.example',
    WEB_APP_URL: 'https://app.meetingid.example',
  });
  resetEnvCache();
  google = fakeGoogle();
  setGoogleFetch(google.fetch);
  workspace = await seedWorkspace();
  const res = await request(app).post('/api/v1/auth/login').send({ code: ACCESS_CODE });
  token = res.body.token as string;
});
afterEach(() => {
  setGoogleFetch(null);
  for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'PUBLIC_API_URL', 'WEB_APP_URL'])
    delete process.env[k];
  resetEnvCache();
});

const auth = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${token}`);

async function seedMeeting(folder: string | null = 'Jolto') {
  const m = await MeetingModel.create({
    workspaceId: workspace._id,
    title: 'Vendor meeting',
    date: new Date('2026-10-20T05:00:00Z'),
    status: 'completed',
    stage: 'done',
    folder,
    summary: '## Decisions\n- Go ahead',
    actionItems: [{ speakerName: 'Heet', text: 'Send the PO' }],
    audio: { originalUrl: 'x', originalPublicId: 'x' },
  });
  await MeetingDataModel.create({
    meetingId: m._id,
    lines: [
      {
        start: 0,
        end: 4,
        speakerName: 'Heet',
        textRoman: 'Chalo shuru karte hain',
        textNative: '',
      },
    ],
  });
  return String(m._id);
}

async function connect() {
  const cb = await request(app).get(
    `/api/v1/integrations/google/callback?code=abc&state=${encodeURIComponent(signState(String(workspace._id)))}`,
  );
  expect(cb.status).toBe(302);
  expect(cb.headers.location).toBe('https://app.meetingid.example/settings?drive=connected');
}

describe('folders for meetings (client request, 20 Oct)', () => {
  it('starts with Jolto, Internal and Consultant, can be changed, and files meetings', async () => {
    const me = await auth(request(app).get('/api/v1/auth/me')).expect(200);
    expect(me.body.workspace.folders).toEqual(['Jolto', 'Internal', 'Consultant']);
    await auth(request(app).put('/api/v1/workspace/folders'))
      .send({ folders: ['Jolto', 'Internal', 'Consultant', 'Vendors', 'Vendors'] })
      .expect(200, { folders: ['Jolto', 'Internal', 'Consultant', 'Vendors'] });

    const id = await seedMeeting(null);
    const moved = await auth(request(app).patch(`/api/v1/meetings/${id}`))
      .send({ folder: 'Vendors' })
      .expect(200);
    expect(moved.body.meeting.folder).toBe('Vendors');
    await auth(request(app).patch(`/api/v1/meetings/${id}`))
      .send({ folder: 'Nope' })
      .expect(400);
    const cleared = await auth(request(app).patch(`/api/v1/meetings/${id}`))
      .send({ folder: null })
      .expect(200);
    expect(cleared.body.meeting.folder).toBeNull();
    // renaming still works on its own
    await auth(request(app).patch(`/api/v1/meetings/${id}`))
      .send({ title: 'Renamed' })
      .expect(200);
  });
});

describe('Google Drive connection', () => {
  it('connects through Google and keeps the token encrypted', async () => {
    let s = await auth(request(app).get('/api/v1/integrations/google')).expect(200);
    expect(s.body).toEqual({ available: true, connected: false, email: null });

    const start = await auth(request(app).post('/api/v1/integrations/google/start')).expect(200);
    const url = new URL(start.body.url as string);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toContain('auth/drive.file');
    expect(url.searchParams.get('scope')).not.toMatch(/auth\/drive( |$)/);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.meetingid.example/api/v1/integrations/google/callback',
    );
    expect(url.searchParams.get('access_type')).toBe('offline');

    await connect();
    s = await auth(request(app).get('/api/v1/integrations/google')).expect(200);
    expect(s.body).toEqual({ available: true, connected: true, email: 'heet@kisna.in' });
    const w = await WorkspaceModel.findById(workspace._id).lean();
    expect(JSON.stringify(w?.google)).not.toContain('rt-secret');
    expect(openToken(w!.google!.refreshTokenEnc)).toBe('rt-secret');

    await auth(request(app).delete('/api/v1/integrations/google')).expect(204);
    expect(google.calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke'))).toBe(
      true,
    );
    s = await auth(request(app).get('/api/v1/integrations/google')).expect(200);
    expect(s.body.connected).toBe(false);
  });

  it('refuses a forged or expired state, and says when Google is not set up', async () => {
    const forged = await request(app).get(
      `/api/v1/integrations/google/callback?code=abc&state=${String(workspace._id)}.9999999999999.00.bad`,
    );
    expect(forged.headers.location).toBe('https://app.meetingid.example/settings?drive=failed');
    const old = signState(String(workspace._id), Date.now() - 60 * 60_000);
    const expired = await request(app).get(
      `/api/v1/integrations/google/callback?code=abc&state=${encodeURIComponent(old)}`,
    );
    expect(expired.headers.location).toBe('https://app.meetingid.example/settings?drive=failed');
    expect((await WorkspaceModel.findById(workspace._id).lean())?.google).toBeNull();

    delete process.env.GOOGLE_CLIENT_ID;
    resetEnvCache();
    const s = await auth(request(app).get('/api/v1/integrations/google')).expect(200);
    expect(s.body.available).toBe(false);
    await auth(request(app).post('/api/v1/integrations/google/start')).expect(503);
  });
});

const MEETING = '507f1f77bcf86cd799439011';

/** Re-sign a payload with the server's state key, so a test can prove the key matches and then change the payload. */
function resign(payload: string): string {
  const key = Buffer.from(
    hkdfSync('sha256', env().JWT_SECRET, 'meetingid', 'google-oauth-state', 32),
  );
  const mac = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

describe('Save to Drive comes back to the meeting', () => {
  it('refuses a return that leaves the site, including mutated ones', () => {
    const path = `/meetings/${MEETING}`;
    const bad: unknown[] = [
      `https://evil.example/meetings/${MEETING}`,
      `http://evil.example${path}`,
      `//evil.example${path}`,
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      `${path}/../settings`,
      `/meetings/../meetings/${MEETING}`,
      `${path}/extra`,
      '/settings',
      `${MEETING}.evil.com`,
      `${path}?folder=https://evil.example`,
      `${path}?folder=../evil`,
      `${path}?folder=Jolto/../../x`,
      `${path}?folder=Jolto&next=https://evil.example`,
      `${path}?redirect=https://evil.example`,
      `https://app.meetingid.example${path}`,
      `${path}#https://evil.example`,
      `\\meetings\\${MEETING}`,
      ` ${path}`,
      '',
      { meetingId: `https://evil.example/meetings/${MEETING}`, folder: 'Jolto' },
      { meetingId: MEETING, folder: 'https://evil.example/x' },
      { meetingId: MEETING, folder: '//evil.example' },
      { meetingId: MEETING, folder: '../evil' },
      { meetingId: MEETING, folder: 'javascript:alert(1)' },
      { meetingId: path, folder: null },
      { meetingId: MEETING, folder: 'Jolto', url: 'https://evil.example' },
      { meetingId: MEETING, folder: 'a'.repeat(61) },
    ];
    for (const input of bad) expect(parseReturnTo(input), JSON.stringify(input)).toBeNull();

    expect(parseReturnTo(MEETING)).toEqual({ meetingId: MEETING, folder: null });
    expect(parseReturnTo(MEETING.toUpperCase())).toEqual({ meetingId: MEETING, folder: null });
    expect(parseReturnTo(path)).toEqual({ meetingId: MEETING, folder: null });
    expect(parseReturnTo(`${path}?folder=Jolto`)).toEqual({ meetingId: MEETING, folder: 'Jolto' });
    expect(parseReturnTo({ meetingId: MEETING, folder: 'Jolto' })).toEqual({
      meetingId: MEETING,
      folder: 'Jolto',
    });
    expect(parseReturnTo({ meetingId: MEETING })).toEqual({ meetingId: MEETING, folder: null });
    expect(meetingReturnPath(MEETING, 'save')).toBe(`${path}?drive=save`);
    expect(() => meetingReturnPath(MEETING, 'https://evil.example')).toThrow(/invalid return/);
    expect(() =>
      signState(String(workspace._id), Date.now(), { meetingId: 'not-an-id', folder: null }),
    ).toThrow(/invalid return/);
  });

  it('rejects a signed return that is not a meeting, and an extra field', () => {
    const exp = Date.now() + 60_000;
    const nonce = 'ab'.repeat(8);
    const good = Buffer.from(
      JSON.stringify({ meetingId: MEETING, folder: 'Jolto' }),
      'utf8',
    ).toString('base64url');
    const prefix = `${workspace._id}.${exp}.${nonce}`;
    expect(readState(resign(`${prefix}.${good}`))).toEqual({
      workspaceId: String(workspace._id),
      returnTo: { meetingId: MEETING, folder: 'Jolto' },
    });
    const evil = Buffer.from(
      JSON.stringify({ meetingId: 'https://evil.example', folder: null }),
      'utf8',
    ).toString('base64url');
    expect(readState(resign(`${prefix}.${evil}`))).toBeNull();
    expect(readState(resign(`${prefix}.${good}.extra`))).toBeNull();
  });

  it('signs the meeting and folder, and the callback opens that meeting ready to save', async () => {
    const id = await seedMeeting('Jolto');
    const offSite = await auth(request(app).post('/api/v1/integrations/google/start'))
      .send({ returnTo: `https://evil.example/meetings/${id}` })
      .expect(400);
    expect(offSite.body.error).toBe('invalid_request');
    expect(JSON.stringify(offSite.body)).not.toContain('accounts.google.com');
    await auth(request(app).post('/api/v1/integrations/google/start'))
      .send({ returnTo: { meetingId: id, folder: 'https://evil.example/x' } })
      .expect(400);

    const started = await auth(request(app).post('/api/v1/integrations/google/start'))
      .send({ returnTo: { meetingId: id, folder: 'Jolto' } })
      .expect(200);
    const state = new URL(started.body.url as string).searchParams.get('state')!;
    expect(readState(state)).toEqual({
      workspaceId: String(workspace._id),
      returnTo: { meetingId: id, folder: 'Jolto' },
    });

    const old = signState(String(workspace._id), Date.now() - 60 * 60_000, {
      meetingId: id,
      folder: 'Jolto',
    });
    const expired = await request(app).get(
      `/api/v1/integrations/google/callback?code=abc&state=${encodeURIComponent(old)}`,
    );
    expect(expired.headers.location).toBe('https://app.meetingid.example/settings?drive=failed');

    const at = state.lastIndexOf('.');
    const mac = state.slice(at + 1);
    const flipped = `${mac[0] === 'a' ? 'b' : 'a'}${mac.slice(1)}`;
    const tampered = await request(app).get(
      `/api/v1/integrations/google/callback?code=abc&state=${encodeURIComponent(`${state.slice(0, at + 1)}${flipped}`)}`,
    );
    expect(tampered.headers.location).toBe('https://app.meetingid.example/settings?drive=failed');
    expect((await WorkspaceModel.findById(workspace._id).lean())?.google).toBeNull();

    const cancelled = await request(app).get(
      `/api/v1/integrations/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    expect(cancelled.status).toBe(302);
    expect(cancelled.headers.location).toBe(
      `https://app.meetingid.example/meetings/${id}?drive=cancelled`,
    );
    expect((await WorkspaceModel.findById(workspace._id).lean())?.google).toBeNull();

    const cb = await request(app).get(
      `/api/v1/integrations/google/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe(`https://app.meetingid.example/meetings/${id}?drive=save`);
    expect(cb.headers.location).not.toContain('Jolto');
    expect(cb.headers.location).not.toContain('evil');
  });
});

describe('Save to Drive', () => {
  it('makes MeetingID/<folder> and a Google Doc; again updates the same Doc and follows a folder change', async () => {
    const id = await seedMeeting('Jolto');
    await auth(request(app).post(`/api/v1/meetings/${id}/drive`)).expect(409); // not connected yet
    await connect();

    const first = await auth(request(app).post(`/api/v1/meetings/${id}/drive`)).expect(200);
    const drive = first.body.meeting.drive;
    expect(drive).toMatchObject({
      folder: 'Jolto',
      url: expect.stringContaining('docs.google.com'),
    });
    const folders = google.calls.filter(
      (c) => c.url.startsWith('https://www.googleapis.com/drive/v3/files?') && c.method === 'POST',
    );
    expect(folders.map((c) => JSON.parse(c.body).name)).toEqual(['MeetingID', 'Jolto']);
    const upload = google.calls.find((c) => c.url.includes('upload/drive') && c.method === 'POST')!;
    expect(upload.body).toContain('"mimeType":"application/vnd.google-apps.document"');
    expect(upload.body).toContain('"name":"2026-10-20 · Vendor meeting"');
    expect(google.files.get(drive.fileId)?.parents).toEqual(['folder-2']);

    // pressing it again: the same Doc, no new folders
    google.calls.length = 0;
    const again = await auth(request(app).post(`/api/v1/meetings/${id}/drive`)).expect(200);
    expect(again.body.meeting.drive.fileId).toBe(drive.fileId);
    expect(google.calls.filter((c) => c.method === 'POST' && c.url.includes('files?'))).toEqual([]);
    expect(google.calls.some((c) => c.method === 'PATCH' && c.url.includes(drive.fileId))).toBe(
      true,
    );

    // filed under Internal now: the Doc moves to MeetingID/Internal
    await auth(request(app).patch(`/api/v1/meetings/${id}`))
      .send({ folder: 'Internal' })
      .expect(200);
    const moved = await auth(request(app).post(`/api/v1/meetings/${id}/drive`)).expect(200);
    expect(moved.body.meeting.drive).toMatchObject({ fileId: drive.fileId, folder: 'Internal' });
    // a new "Internal" folder inside MeetingID holds the Doc now
    const [parent] = google.files.get(drive.fileId)!.parents;
    expect(parent).not.toBe('folder-2');
    expect(google.files.get(parent!)?.parents).toEqual(['folder-1']);
    const made = google.calls.find((c) => c.body.includes('"name":"Internal"'));
    expect(made).toBeTruthy();
  });

  it('asks to connect again when the stored sign-in can no longer be read (server secret changed)', async () => {
    const id = await seedMeeting();
    await connect();
    await WorkspaceModel.updateOne(
      { _id: workspace._id },
      { $set: { 'google.refreshTokenEnc': 'AAAA.BBBB.CCCC' } },
    );
    const res = await auth(request(app).post(`/api/v1/meetings/${id}/drive`)).expect(409);
    expect(res.body.error).toBe('drive_reconnect');
    // disconnecting works too
    await connect();
    await WorkspaceModel.updateOne(
      { _id: workspace._id },
      { $set: { 'google.refreshTokenEnc': 'AAAA.BBBB.CCCC' } },
    );
    await auth(request(app).delete('/api/v1/integrations/google')).expect(204);
  });

  it('asks to connect again when Google access was removed', async () => {
    const id = await seedMeeting();
    await connect();
    google.breakRefresh();
    const res = await auth(request(app).post(`/api/v1/meetings/${id}/drive`)).expect(409);
    expect(res.body.error).toBe('drive_reconnect');
    expect((await WorkspaceModel.findById(workspace._id).lean())?.google).toBeNull();
  });

  it('needs a transcript first', async () => {
    const id = await seedMeeting();
    await MeetingDataModel.updateOne({ meetingId: id }, { $set: { lines: [] } });
    await connect();
    await auth(request(app).post(`/api/v1/meetings/${id}/drive`)).expect(409);
  });
});
