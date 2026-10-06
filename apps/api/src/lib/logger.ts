import { pino, type Logger } from 'pino';

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: { service: process.env.SERVICE_NAME ?? 'meetingid-api' },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.apiKey', '*.api_key', '*.token'],
    censor: '[redacted]',
  },
});

/** Child logger that stamps every line with the job context. */
export function jobLogger(ctx: {
  meetingId: string;
  jobId: string;
  stage: string;
  step?: number | null;
}): Logger {
  return logger.child(ctx);
}
