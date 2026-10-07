import request from 'supertest';
import JSZip from 'jszip';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { MeetingDataModel, MeetingModel, type WorkspaceDoc } from '../src/models/index.js';
import { splitByScript } from '../src/services/export/docx.js';
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
  const res = await request(app).post('/api/v1/auth/login').send({ code: ACCESS_CODE });
  token = res.body.token as string;
});

const get = (url: string) =>
  request(app)
    .get(url)
    .set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

async function seed(): Promise<string> {
  const m = await MeetingModel.create({
    workspaceId: workspace._id,
    title: 'Meeting 21/9 — કિસ્ના',
    summary: '## Overview\nWe agreed the **festival** offer.\n- Pricing रखें\n- ક્ષેત્ર સમીક્ષા',
    actionItems: [{ speakerName: 'Speaker A', text: 'Send the plan' }],
    durationSec: 600,
    audio: { originalUrl: 'x', originalPublicId: 'x' },
  });
  await MeetingDataModel.create({
    meetingId: m._id,
    lines: [
      {
        speakerName: 'Speaker A',
        start: 5,
        end: 9,
        textRoman: 'aaj hum discuss karenge',
        textNative: 'आज हम discuss करेंगे',
      },
      {
        speakerName: 'Speaker B',
        start: 70,
        end: 75,
        textRoman: 'saru',
        textNative: 'સારું, ચાલો શરૂ કરીએ',
      },
    ],
  });
  return String(m._id);
}

describe('splitByScript', () => {
  it('gives Devanagari and Gujarati their own runs and keeps a trailing space with the script before it', () => {
    expect(splitByScript('hello आज हम ok')).toEqual([
      { text: 'hello ', font: null },
      { text: 'आज हम ', font: 'Noto Sans Devanagari' },
      { text: 'ok', font: null },
    ]);
    expect(splitByScript('સારું, ચાલો').map((s) => s.font)).toEqual(['Noto Sans Gujarati']);
  });
});

describe('Word export', () => {
  it('is a .docx with both scripts and the fonts embedded', async () => {
    const id = await seed();
    const res = await get(`/api/v1/meetings/${id}/export?format=docx&script=both`).expect(200);
    expect(res.headers['content-type']).toContain('wordprocessingml.document');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="Meeting_21_9/);
    const zip = await JSZip.loadAsync(res.body as Buffer);
    const names = Object.keys(zip.files);
    // the two Noto fonts travel inside the file
    expect(names.filter((n) => n.startsWith('word/fonts/') && n.endsWith('.odttf'))).toHaveLength(
      2,
    );
    const fontTable = await zip.file('word/fontTable.xml')!.async('string');
    expect(fontTable).toContain('Noto Sans Devanagari');
    expect(fontTable).toContain('Noto Sans Gujarati');
    expect(fontTable).toContain('embedRegular');
    const doc = await zip.file('word/document.xml')!.async('string');
    expect(doc).toContain('સારું, ચાલો શરૂ કરીએ');
    expect(doc).toContain('आज हम');
    expect(doc).toContain('aaj hum discuss karenge');
    expect(doc).toContain('Speaker B');
    expect(doc).toContain('Send the plan');
    expect(doc).toContain('festival'); // summary
    expect(doc).toContain('[1:10]'); // timestamps
    // each Indic run names its own font
    expect(doc).toMatch(/w:cs="Noto Sans Gujarati"/);
    expect(doc).toMatch(/w:cs="Noto Sans Devanagari"/);
  });

  it('roman-only leaves the native script out', async () => {
    const id = await seed();
    const res = await get(`/api/v1/meetings/${id}/export?script=roman`).expect(200);
    const doc = await (
      await JSZip.loadAsync(res.body as Buffer)
    )
      .file('word/document.xml')!
      .async('string');
    expect(doc).toContain('aaj hum discuss karenge');
    expect(doc).not.toContain('શરૂ કરીએ');
  });

  it('refuses a meeting with no transcript yet, another workspace’s meeting, and a bad script', async () => {
    const empty = await MeetingModel.create({
      workspaceId: workspace._id,
      title: 'Empty',
      audio: { originalUrl: 'x', originalPublicId: 'x' },
    });
    await MeetingDataModel.create({ meetingId: empty._id });
    await get(`/api/v1/meetings/${String(empty._id)}/export`).expect(409);
    const id = await seed();
    await get(`/api/v1/meetings/${id}/export?script=klingon`).expect(400);
    await request(app).get(`/api/v1/meetings/${id}/export`).expect(401);
  });
});
