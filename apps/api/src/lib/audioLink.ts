import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Playback links for audio on private storage. The link names the object and carries an HMAC made with
 * JWT_SECRET, so it cannot be forged or pointed at another object, and it stops working if the secret is
 * rotated. The API answers it with a redirect to a short-lived storage link (routes/audio.ts).
 */
const sign = (key: string): string =>
  createHmac('sha256', env().JWT_SECRET).update(`audio:${key}`).digest('hex').slice(0, 40);

export function audioLink(key: string): string {
  const base = (env().PUBLIC_API_URL ?? '').replace(/\/+$/, '');
  return `${base}/api/v1/audio?k=${encodeURIComponent(key)}&t=${sign(key)}`;
}

export function audioLinkValid(key: string, token: string): boolean {
  const want = Buffer.from(sign(key));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}
