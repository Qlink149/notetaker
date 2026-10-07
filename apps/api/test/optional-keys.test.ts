import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { engineStatus, env, requireEnv, resetEnvCache } from '../src/config/env.js';
import { classify, FatalError } from '../src/pipeline/errors.js';
import { ACCESS_CODE, fakeStorage, seedWorkspace, startDb, stopDb } from './helpers.js';

const OPTIONAL = [
  'DEEPGRAM_API_KEY',
  'PYANNOTEAI_API_KEY',
  'SARVAM_API_KEY',
  'OPENAI_API_KEY',
] as const;

describe('optional provider keys', () => {
  beforeAll(async () => {
    await startDb();
    for (const k of OPTIONAL) delete process.env[k];
    process.env.DEEPGRAM_API_KEY = ''; // a blank line in .env counts as unset
    resetEnvCache();
    await seedWorkspace();
  });
  afterAll(stopDb);

  it('boots without Deepgram, pyannote, Sarvam or OpenAI keys', () => {
    expect(() => env()).not.toThrow();
    expect(env().DEEPGRAM_API_KEY).toBeUndefined();
    expect(engineStatus()).toMatchObject({
      gemini: { enabled: true },
      deepgram: { enabled: false, reason: 'DEEPGRAM_API_KEY is not set' },
      sarvam: { enabled: false },
    });
  });

  it('a missing key is a fatal (never retried) error with a clear message', () => {
    let err: unknown;
    try {
      requireEnv('DEEPGRAM_API_KEY');
    } catch (e) {
      err = e;
    }
    const c = classify(err);
    expect(c).toBeInstanceOf(FatalError);
    expect(c.message).toBe('DEEPGRAM_API_KEY is not set (see .env.example)');
  });

  it('disables the routes that need a missing key', async () => {
    const app = createApp({
      storage: await fakeStorage(),
      geminiFiles: {
        upload: async () => ({ uri: 'u', name: 'n', mimeType: 'audio/flac', keyId: 'k1' }),
        delete: async () => undefined,
      },
      createVoiceprint: async () => 'vp',
    });
    const health = await request(app).get('/api/v1/health').expect(200);
    expect(health.body.engines).toMatchObject({ gemini: true, deepgram: false });

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ code: ACCESS_CODE })
      .expect(200);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${login.body.token}`);

    const sign = await auth(request(app).post('/api/v1/uploads/sign')).expect(200);
    const res = await auth(request(app).post('/api/v1/meetings'))
      .send({
        meetingId: sign.body.meetingId,
        title: 't',
        publicId: `${sign.body.folder}/x`,
        url: 'https://x.example/a',
        engine: 'deepgram',
      })
      .expect(400);
    expect(res.body.error).toContain('DEEPGRAM_API_KEY is not set');

    await auth(request(app).put('/api/v1/workspace/settings'))
      .send({ engine: 'deepgram', languages: ['hi'], scriptPreference: 'roman', summaryModel: 'm' })
      .expect(400);

    delete process.env.PYANNOTEAI_API_KEY;
    resetEnvCache();
    const enrol = await auth(request(app).post('/api/v1/speakers/enrol'))
      .send({ name: 'X', audioUrl: 'https://a.example/x.wav' })
      .expect(503);
    expect(enrol.body.error).toContain('PYANNOTEAI_API_KEY is not set');
  });
});
