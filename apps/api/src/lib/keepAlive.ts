import { logger } from './logger.js';

const EVERY_MS = 8 * 60_000;

/**
 * Calls each address now and every 8 minutes so a free Render service that nothing else calls (the
 * worker) does not fall asleep and leave uploads waiting. Failures are only logged: a service that is
 * waking up answers slowly, and the next round tries again. Returns a function that stops it.
 */
export function startKeepAlive(urls: string[], fetchFn: typeof fetch = fetch): () => void {
  if (!urls.length) return () => undefined;
  const ping = async (): Promise<void> => {
    await Promise.all(
      urls.map(async (url) => {
        try {
          const res = await fetchFn(url, { signal: AbortSignal.timeout(90_000) });
          logger.debug({ url, status: res.status }, 'keep-alive ping');
        } catch (err) {
          logger.warn({ url, err: (err as Error).message }, 'keep-alive ping failed');
        }
      }),
    );
  };
  void ping();
  const timer = setInterval(() => void ping(), EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
