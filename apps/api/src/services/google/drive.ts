import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../../config/env.js';

// Google Drive for "Save to Drive" (client request, 20 Oct: "the final step is transfer to drive"). Plain REST
// calls; the only permission asked is `drive.file`, so the app sees the files and folders it made and nothing
// else in the person's Drive.

export const DRIVE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'];
const FOLDER = 'application/vnd.google-apps.folder';
const GOOGLE_DOC = 'application/vnd.google-apps.document';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** The top folder made in the person's Drive. */
export const ROOT_FOLDER = 'MeetingID';

type Fetch = typeof fetch;
let fetcher: Fetch = (...a) => fetch(...a);
/** Tests stand in for Google. */
export function setGoogleFetch(f: Fetch | null): void {
  fetcher = f ?? ((...a) => fetch(...a));
}

export class GoogleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The OAuth client is set up and the API knows its public address (Google redirects back to it). */
export function driveAvailable(): boolean {
  const e = env();
  return Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET && e.PUBLIC_API_URL);
}

export const redirectUri = (): string =>
  `${env().PUBLIC_API_URL!.replace(/\/$/, '')}/api/v1/integrations/google/callback`;

/** Where the browser goes back to after connecting (the web app's Settings). */
export const webAppUrl = (): string =>
  (env().WEB_APP_URL ?? env().CORS_ORIGINS[0] ?? 'http://localhost:5173').replace(/\/$/, '');

// ---------- the refresh token at rest, and the OAuth state ----------

const key = (purpose: string): Buffer =>
  Buffer.from(hkdfSync('sha256', env().JWT_SECRET, 'meetingid', purpose, 32));

export function sealToken(token: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key('google-refresh-token'), iv);
  const body = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function openToken(sealed: string): string {
  const [iv, tag, body] = sealed.split('.').map((x) => Buffer.from(x, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key('google-refresh-token'), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(body!), d.final()]).toString('utf8');
}

const STATE_TTL_MS = 15 * 60_000;

/** Ties Google's redirect back to the workspace that started it (the redirect carries no login). */
export function signState(workspaceId: string, now = Date.now()): string {
  const payload = `${workspaceId}.${now + STATE_TTL_MS}.${randomBytes(8).toString('hex')}`;
  const mac = createHmac('sha256', key('google-oauth-state')).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

/** The workspace id in a state this server signed, or null when forged or expired. */
export function readState(state: string, now = Date.now()): string | null {
  const i = state.lastIndexOf('.');
  if (i < 0) return null;
  const payload = state.slice(0, i);
  const mac = Buffer.from(state.slice(i + 1));
  const want = Buffer.from(
    createHmac('sha256', key('google-oauth-state')).update(payload).digest('base64url'),
  );
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
  const [workspaceId, exp] = payload.split('.');
  if (!workspaceId || !(Number(exp) > now)) return null;
  return workspaceId;
}

// ---------- OAuth ----------

export function authUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: env().GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: DRIVE_SCOPES.join(' '),
    access_type: 'offline',
    // always ask, so Google returns a refresh token even when the account connected before
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new GoogleError(res.status, `${what}: ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function tokenCall(params: Record<string, string>) {
  const res = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env().GOOGLE_CLIENT_ID!,
      client_secret: env().GOOGLE_CLIENT_SECRET!,
      ...params,
    }),
  });
  return json<{ access_token: string; refresh_token?: string; scope?: string }>(
    res,
    'Google token',
  );
}

/** The code Google sent back → a refresh token (kept) and the account's address. */
export async function exchangeCode(
  code: string,
): Promise<{ refreshToken: string; email: string | null }> {
  const t = await tokenCall({
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
  });
  if (!t.refresh_token) throw new GoogleError(400, 'Google did not return a refresh token');
  if (t.scope && !t.scope.includes('drive.file'))
    throw new GoogleError(403, 'Drive access was not granted');
  const me = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${t.access_token}` },
  })
    .then((r) => (r.ok ? (r.json() as Promise<{ email?: string }>) : {}))
    .catch(() => ({}) as { email?: string });
  return { refreshToken: t.refresh_token, email: (me as { email?: string }).email ?? null };
}

export async function accessToken(sealedRefresh: string): Promise<string> {
  let refresh: string;
  try {
    refresh = openToken(sealedRefresh);
  } catch {
    // sealed with an earlier server secret: the person connects again
    throw new GoogleError(401, 'the stored Google sign-in can no longer be read');
  }
  const t = await tokenCall({
    refresh_token: refresh,
    grant_type: 'refresh_token',
  });
  return t.access_token;
}

/** Disconnecting: tell Google to forget the grant (best effort). */
export async function revoke(sealedRefresh: string): Promise<void> {
  try {
    openToken(sealedRefresh);
  } catch {
    return; // unreadable: nothing to revoke from here
  }
  await fetcher(
    `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(openToken(sealedRefresh))}`,
    {
      method: 'POST',
    },
  ).catch(() => undefined);
}

// ---------- Drive ----------

const api = 'https://www.googleapis.com/drive/v3/files';
const upload = 'https://www.googleapis.com/upload/drive/v3/files';

/** A file or folder this app made, unless it is gone or in the bin. */
async function alive(token: string, id: string): Promise<{ parents: string[] } | null> {
  const res = await fetcher(`${api}/${id}?fields=id,trashed,parents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  const f = await json<{ trashed?: boolean; parents?: string[] }>(res, 'Drive get');
  return f.trashed ? null : { parents: f.parents ?? [] };
}

/** The folder `known` if it still exists, else a new one named `name` (under `parent`). */
export async function ensureFolder(
  token: string,
  name: string,
  parent: string | null,
  known: string | null,
): Promise<string> {
  if (known && (await alive(token, known))) return known;
  const res = await fetcher(`${api}?fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) }),
  });
  return (await json<{ id: string }>(res, 'Drive folder')).id;
}

function multipart(
  meta: object,
  body: Buffer,
  type: string,
): { body: Buffer; contentType: string } {
  const b = `meetingid${randomBytes(8).toString('hex')}`;
  return {
    contentType: `multipart/related; boundary=${b}`,
    body: Buffer.concat([
      Buffer.from(
        `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${type}\r\n\r\n`,
      ),
      body,
      Buffer.from(`\r\n--${b}--`),
    ]),
  };
}

/**
 * Save `docx` as a Google Doc named `name` in `folderId`: the same Doc again when `fileId` still exists (its
 * content replaced, moved if the folder changed), else a new one. Drive converts the Word file itself.
 */
export async function saveDoc(
  token: string,
  {
    fileId,
    name,
    folderId,
    docx,
  }: { fileId: string | null; name: string; folderId: string; docx: Buffer },
): Promise<{ fileId: string; url: string }> {
  const existing = fileId ? await alive(token, fileId) : null;
  const fields = 'fields=id,webViewLink';
  let res: Response;
  if (fileId && existing) {
    const move = existing.parents.includes(folderId)
      ? ''
      : `&addParents=${folderId}&removeParents=${existing.parents.join(',')}`;
    const m = multipart({ name }, docx, DOCX);
    res = await fetcher(`${upload}/${fileId}?uploadType=multipart&${fields}${move}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': m.contentType },
      body: m.body,
    });
  } else {
    const m = multipart({ name, mimeType: GOOGLE_DOC, parents: [folderId] }, docx, DOCX);
    res = await fetcher(`${upload}?uploadType=multipart&${fields}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': m.contentType },
      body: m.body,
    });
  }
  const f = await json<{ id: string; webViewLink?: string }>(res, 'Drive upload');
  return { fileId: f.id, url: f.webViewLink ?? `https://docs.google.com/document/d/${f.id}/edit` };
}
