import { Router } from 'express';
import { audioLinkValid } from '../lib/audioLink.js';
import { HttpError } from '../lib/http.js';
import type { ApiDeps } from './deps.js';

/** GET /audio?k=<object key>&t=<token>: a signed playback link, answered with a short-lived storage link. */
export function audioRouter(deps: ApiDeps): Router {
  const r = Router();
  r.get('/audio', async (req, res) => {
    const key = typeof req.query.k === 'string' ? req.query.k : '';
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    if (!key || !token || !audioLinkValid(key, token))
      throw new HttpError(403, 'invalid_audio_link');
    if (!deps.storage.presignGet) throw new HttpError(404, 'audio_not_available');
    const url = await deps.storage.presignGet(key);
    // the storage link is the same for an hour, so the browser may keep this answer for a while too
    res.set('Cache-Control', 'private, max-age=1800').redirect(302, url);
  });
  return r;
}
