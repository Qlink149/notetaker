import type { ErrorRequestHandler, Request } from 'express';
import { Types } from 'mongoose';
import { ZodError, type ZodTypeAny, type output } from 'zod';
import { engineStatus } from '../config/env.js';
import { logger } from './logger.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Not found'): HttpError => new HttpError(404, what);

/** Parse a request body with a shared zod schema; a failure becomes a 400. */
export function body<S extends ZodTypeAny>(schema: S, req: Request): output<S> {
  return schema.parse(req.body ?? {});
}

/** Parse an ObjectId route param; an invalid id is a 404 (it cannot exist). */
export function idParam(req: Request, name = 'id'): Types.ObjectId {
  const raw = req.params[name];
  if (typeof raw !== 'string' || !Types.ObjectId.isValid(raw)) throw notFound();
  return new Types.ObjectId(raw);
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'invalid_request', issues: err.issues });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const status =
    typeof (err as { status?: unknown }).status === 'number'
      ? (err as { status: number }).status
      : 500;
  if (status >= 500) logger.error({ err, path: req.path }, 'request failed');
  res.status(status).json({ error: status >= 500 ? 'internal_error' : (err as Error).message });
};

/** Refuse to use an engine whose API key is not configured. */
export async function assertEngineEnabled(engines: string[]): Promise<void> {
  const status = engineStatus() as Record<string, { enabled: boolean; reason?: string }>;
  const off = engines.filter((e) => !status[e]?.enabled);
  if (off.length) {
    throw new HttpError(
      400,
      `engine_unavailable: ${off.map((e) => `${e} (${status[e]?.reason ?? 'unknown engine'})`).join(', ')}`,
    );
  }
}
