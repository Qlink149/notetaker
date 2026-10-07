import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router, type Express } from 'express';
import { engineStatus, env } from './config/env.js';
import { mongoReady } from './db/mongo.js';
import { requireAuth } from './lib/auth.js';
import { errorHandler } from './lib/http.js';
import { logger } from './lib/logger.js';
import { HeartbeatModel } from './models/index.js';
import { auditRouter } from './routes/audit.js';
import { benchmarkRouter } from './routes/benchmark.js';
import type { ApiDeps } from './routes/deps.js';
import { meetingSpeakersRouter } from './routes/meetingSpeakers.js';
import { meetingsRouter } from './routes/meetings.js';
import { sessionsGuestRouter, sessionsHostRouter } from './routes/sessions.js';
import { speakersRouter } from './routes/speakers.js';
import { authRouter, workspaceRouter } from './routes/workspace.js';

export function createApp(deps: ApiDeps): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const origins = new Set(['http://localhost:5173', ...env().CORS_ORIGINS]);
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || origins.has(origin)),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      if (req.path.endsWith('/health')) return;
      logger.info(
        { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started },
        'http',
      );
    });
    next();
  });

  const v1 = Router();
  v1.get('/health', async (_req, res) => {
    const beat = mongoReady()
      ? await HeartbeatModel.findOne({}, { lastHeartbeat: 1 }).sort({ lastHeartbeat: -1 }).lean()
      : null;
    res.json({
      ok: mongoReady(),
      db: mongoReady() ? 'up' : 'down',
      worker: { lastHeartbeat: beat?.lastHeartbeat ?? null },
      engines: Object.fromEntries(Object.entries(engineStatus()).map(([k, v]) => [k, v.enabled])),
    });
  });
  v1.use(authRouter());
  // group recording (must come before workspaceRouter, which requires login for everything after it): guests are not logged in; they present the token they got when joining
  v1.use(sessionsGuestRouter(deps));
  v1.use(workspaceRouter());
  const authed = Router();
  authed.use(requireAuth);
  authed.use(meetingsRouter(deps));
  authed.use(meetingSpeakersRouter(deps));
  authed.use(auditRouter());
  authed.use(sessionsHostRouter());
  authed.use(speakersRouter(deps));
  authed.use(benchmarkRouter());
  v1.use(authed);

  app.use('/api/v1', v1);
  app.use(errorHandler);
  return app;
}
