import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import {
  MeetingDataModel,
  MeetingModel,
  SpendModel,
  type WorkspaceDoc,
} from '../src/models/index.js';
import { ACCESS_CODE, clearDb, fakeStorage, seedWorkspace, startDb, stopDb } from './helpers.js';

let app: Express;
let workspace: WorkspaceDoc;
let token: string;

beforeAll(async () => {
  await startDb();
  app = createApp({
    storage: await fakeStorage(),
    geminiFiles: {
      upload: async () => ({ uri: 'u', name: 'n', mimeType: 'audio/flac', keyId: 'k' }),
      delete: async () => undefined,
    },
    createVoiceprint: async () => 'vp',
  });
});
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  workspace = await seedWorkspace();
  token = (await request(app).post('/api/v1/auth/login').send({ code: ACCESS_CODE })).body
    .token as string;
});

describe('dashboard', () => {
  it('adds up cost, coverage and voice confidence per meeting', async () => {
    const mk = async (
      title: string,
      ratio: number,
      usd: number,
      source: 'pyannote' | 'text-fallback',
    ) => {
      const m = await MeetingModel.create({
        workspaceId: workspace._id,
        title,
        status: 'completed',
        durationSec: 1800,
        coverage: { speechSec: 100, coveredSec: ratio * 100, ratio },
        cost: {
          usd,
          geminiInputTokens: 1000,
          geminiOutputTokens: 500,
          deepgramSec: 120,
          claudeInputTokens: 0,
          claudeOutputTokens: 0,
        },
        audio: { originalUrl: 'x', originalPublicId: 'x' },
      });
      await MeetingDataModel.create({
        meetingId: m._id,
        speakerSource: source,
        lines: [{ speakerName: 'Speaker A', start: 0, end: 5, textNative: 'a', textRoman: 'a' }],
        speakerCards: [
          { diar: 'S0', label: 'Speaker A', status: 'solid', speakerSec: 10, clips: [] },
          { diar: 'S1', label: 'Speaker B', status: 'review', speakerSec: 5, clips: [] },
        ],
      });
    };
    await mk('One', 0.98, 0.5, 'pyannote');
    await mk('Two', 0.8, 0.25, 'text-fallback');
    await SpendModel.create({ _id: 'total', usd: 0.75, byProvider: { gemini: 0.5, claude: 0.25 } });

    const res = await request(app)
      .get('/api/v1/dashboard')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const b = res.body as {
      totals: Record<string, unknown>;
      meetings: {
        title: string;
        usd: number;
        voices: Record<string, number>;
        speakerSource: string;
        deepgramMin: number;
      }[];
    };
    expect(b.totals).toMatchObject({
      meetings: 2,
      hours: 1,
      usdRecorded: 0.75,
      usdLedger: 0.75,
      belowNinety: 1,
      voiceBacked: 1,
    });
    expect(b.totals['averageCoverage']).toBeCloseTo(0.89, 2);
    const one = b.meetings.find((m) => m.title === 'One')!;
    expect(one).toMatchObject({ usd: 0.5, speakerSource: 'pyannote', deepgramMin: 2 });
    expect(one.voices).toMatchObject({ confident: 1, needsReview: 1, newVoices: 0 });
    await request(app).get('/api/v1/dashboard').expect(401);
  });
});
