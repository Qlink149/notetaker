/** A failure worth retrying with backoff: 429, 5xx, network, truncated or looping output, timeouts. */
export class RetryableError extends Error {
  override readonly name = 'RetryableError';
  constructor(
    message: string,
    readonly reason:
      | 'rate_limit'
      | 'server'
      | 'network'
      | 'truncated'
      | 'invalid_output'
      | 'timeout'
      | 'quota'
      | 'waiting'
      | 'other' = 'other',
    options?: { cause?: unknown; retryAfterMs?: number },
  ) {
    super(message, options);
    this.retryAfterMs = options?.retryAfterMs;
  }
  /** Wait this long before the retry instead of the backoff schedule (e.g. a quota reset). */
  readonly retryAfterMs: number | undefined;
}

/** A failure retrying cannot fix: bad request, auth, missing audio, schema violations after retry. */
export class FatalError extends Error {
  override readonly name = 'FatalError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 15_000;

/** `2^attempts × 15 s`: 30 s, 1 min, 2 min, 4 min … */
export function backoffMs(attempts: number): number {
  return 2 ** attempts * BASE_BACKOFF_MS;
}

/** Map an HTTP status from a provider into the right error class. */
export function errorForStatus(provider: string, status: number, body: string): Error {
  const msg = `${provider} ${status}: ${body.slice(0, 500)}`;
  if (status === 429) return new RetryableError(msg, 'rate_limit');
  if (status === 408) return new RetryableError(msg, 'timeout');
  if (status >= 500) return new RetryableError(msg, 'server');
  return new FatalError(msg);
}

const NETWORK =
  /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|aborted|UND_ERR/i;

/** Classify any thrown value. SDK errors expose `status`; raw fetch failures are network errors. */
export function classify(err: unknown): RetryableError | FatalError {
  if (err instanceof RetryableError || err instanceof FatalError) return err;
  const e = err as { status?: unknown; code?: unknown; message?: unknown; name?: unknown };
  if (e?.name === 'NotImplementedError' || e?.name === 'MissingConfigError') {
    return new FatalError(String(e.message), { cause: err });
  }
  const message = typeof e?.message === 'string' ? e.message : String(err);
  const status = typeof e?.status === 'number' ? e.status : undefined;
  if (status !== undefined) {
    const mapped = errorForStatus('provider', status, message);
    mapped.cause = err;
    return mapped as RetryableError | FatalError;
  }
  if (NETWORK.test(message) || NETWORK.test(String(e?.code ?? ''))) {
    return new RetryableError(message, 'network', { cause: err });
  }
  // Unknown errors are retried; the attempt cap stops a genuine bug from looping forever.
  return new RetryableError(message, 'other', { cause: err });
}

/** Short message for the UI, ported from the Base44 `humanizeError` table. */
export function humanizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/no speech detected/i.test(msg)) return 'No speech detected in the recording.';
  if (/quota|rate limit|429|RESOURCE_EXHAUSTED/i.test(msg)) {
    return 'A provider quota or rate limit was hit. Try again in a few minutes.';
  }
  if (NETWORK.test(msg) || /timeout|524/i.test(msg)) {
    return 'Could not reach the audio file or the transcription service timed out. Try again.';
  }
  if (/unsupported|invalid data found|decode|moov atom/i.test(msg)) {
    return 'The audio format is not supported. Try uploading a different file.';
  }
  if (/is not set \(see \.env\.example\)/.test(msg)) return `Server configuration: ${msg}`;
  if (/truncated|repetitive/i.test(msg)) {
    return 'The transcription engine kept producing broken output for part of this recording.';
  }
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}
