import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import { WorkspaceModel, type WorkspaceDoc } from '../models/index.js';
import { HttpError } from './http.js';

// Phase 1 auth: one shared access code per workspace → signed JWT. Phase 4 swaps this file for
// real users; routes only depend on `req.workspace`.

export const TOKEN_COOKIE = 'mid_token';
const TOKEN_TTL = '30d';

declare module 'express-serve-static-core' {
  interface Request {
    workspace?: WorkspaceDoc;
  }
}

export function hashAccessCode(code: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(code, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyAccessCode(code: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(code, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

interface TokenClaims {
  wid: string;
  v: number;
}

export function issueToken(workspace: Pick<WorkspaceDoc, '_id' | 'tokenVersion'>): string {
  const claims: TokenClaims = { wid: String(workspace._id), v: workspace.tokenVersion };
  return jwt.sign(claims, env().JWT_SECRET, { expiresIn: TOKEN_TTL });
}

/** Find the workspace whose access code matches. Few workspaces exist in Phase 1. */
export async function workspaceForCode(code: string): Promise<WorkspaceDoc | null> {
  const all = await WorkspaceModel.find({}).lean<WorkspaceDoc[]>();
  return all.find((w) => verifyAccessCode(code, w.accessCodeHash)) ?? null;
}

function tokenFrom(header: string | undefined, cookie: string | undefined): string | null {
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return cookie ?? null;
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const token = tokenFrom(
    req.headers.authorization,
    (req.cookies as Record<string, string> | undefined)?.[TOKEN_COOKIE],
  );
  if (!token) throw new HttpError(401, 'unauthenticated');
  let claims: TokenClaims;
  try {
    claims = jwt.verify(token, env().JWT_SECRET) as TokenClaims;
  } catch {
    throw new HttpError(401, 'invalid_token');
  }
  if (!Types.ObjectId.isValid(claims.wid)) throw new HttpError(401, 'invalid_token');
  const workspace = await WorkspaceModel.findById(claims.wid).lean<WorkspaceDoc>();
  if (!workspace || workspace.tokenVersion !== claims.v) throw new HttpError(401, 'token_revoked');
  req.workspace = workspace;
  next();
};

/** Workspace of an authenticated request (requireAuth ran). */
export function ws(req: { workspace?: WorkspaceDoc }): WorkspaceDoc {
  if (!req.workspace) throw new HttpError(401, 'unauthenticated');
  return req.workspace;
}
