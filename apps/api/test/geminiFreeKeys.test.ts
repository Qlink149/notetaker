import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { geminiKeyEntries, resetEnvCache } from '../src/config/env.js';

// A free-tier Gemini key must never see a client's recording: Google may use free-tier content to
// improve its products and humans may read it. Free keys are skipped unless explicitly allowed.
const SAVED = { ...process.env };
beforeEach(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://localhost:27017/unused',
    JWT_SECRET: 'x'.repeat(40),
  });
  for (const k of [
    'GEMINI_PAID_API_KEY',
    'GEMINI_API_KEY',
    ...Array.from({ length: 9 }, (_, i) => `GEMINI_API_KEY${i + 1}`),
  ])
    delete process.env[k];
  process.env.GEMINI_API_KEY1 = 'paid-key-1';
  process.env.GEMINI_API_KEY2 = 'paid-key-2';
  process.env.GEMINI_API_KEY4 = 'free-key-4';
  delete process.env.GEMINI_FREE_KEYS;
  delete process.env.GEMINI_ALLOW_FREE_KEYS;
  resetEnvCache();
});
afterEach(() => {
  process.env = { ...SAVED };
  resetEnvCache();
});

describe('free-tier Gemini keys', () => {
  it('are used like any other key when nothing says they are free', () => {
    expect(geminiKeyEntries().map((k) => k.name)).toEqual([
      'GEMINI_API_KEY1',
      'GEMINI_API_KEY2',
      'GEMINI_API_KEY4',
    ]);
  });
  it('are left out of the pool when listed in GEMINI_FREE_KEYS', () => {
    process.env.GEMINI_FREE_KEYS = 'GEMINI_API_KEY4';
    resetEnvCache();
    expect(geminiKeyEntries().map((k) => k.name)).toEqual(['GEMINI_API_KEY1', 'GEMINI_API_KEY2']);
  });
  it('come back only with GEMINI_ALLOW_FREE_KEYS=true (demos with non-client audio)', () => {
    process.env.GEMINI_FREE_KEYS = ' GEMINI_API_KEY4 , GEMINI_API_KEY2 ';
    process.env.GEMINI_ALLOW_FREE_KEYS = 'true';
    resetEnvCache();
    expect(geminiKeyEntries()).toHaveLength(3);
  });
  it('can leave no key at all, which disables Gemini with the usual message', () => {
    process.env.GEMINI_FREE_KEYS = 'GEMINI_API_KEY1,GEMINI_API_KEY2,GEMINI_API_KEY4';
    resetEnvCache();
    expect(geminiKeyEntries()).toHaveLength(0);
  });
});

describe('the paid Gemini key', () => {
  it('is read from GEMINI_PAID_API_KEY and used before the other keys', () => {
    process.env.GEMINI_PAID_API_KEY = 'the-paid-key';
    resetEnvCache();
    expect(geminiKeyEntries().map((k) => k.name)).toEqual([
      'GEMINI_PAID_API_KEY',
      'GEMINI_API_KEY1',
      'GEMINI_API_KEY2',
      'GEMINI_API_KEY4',
    ]);
  });
  it('stays the only key when every other key is listed as free', () => {
    process.env.GEMINI_PAID_API_KEY = 'the-paid-key';
    process.env.GEMINI_FREE_KEYS = 'GEMINI_API_KEY1,GEMINI_API_KEY2,GEMINI_API_KEY4';
    resetEnvCache();
    expect(geminiKeyEntries().map((k) => k.name)).toEqual(['GEMINI_PAID_API_KEY']);
  });
  it('is not counted twice when the same key is also under another name', () => {
    process.env.GEMINI_PAID_API_KEY = 'paid-key-1';
    resetEnvCache();
    expect(geminiKeyEntries().map((k) => k.name)).toEqual([
      'GEMINI_PAID_API_KEY',
      'GEMINI_API_KEY2',
      'GEMINI_API_KEY4',
    ]);
  });
});
