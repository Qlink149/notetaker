import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';
import {
  BudgetExceededError,
  assertBudget,
  recordSpend,
  spentUsd,
  usdFor,
} from '../src/pipeline/budget.js';
import { classify, FatalError } from '../src/pipeline/errors.js';
import { clearDb, startDb, stopDb } from './helpers.js';

describe('spending cap', () => {
  beforeAll(async () => {
    await startDb();
    process.env.SPEND_CAP_USD = '5';
    process.env.GEMINI_PAID = 'false';
    resetEnvCache();
  });
  afterAll(stopDb);
  beforeEach(clearDb);

  it('prices calls from the published rates', () => {
    expect(
      usdFor('gemini', 'gemini-3.8-flash', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBeCloseTo(4.5);
    expect(
      usdFor('claude', 'claude-haiku-4-5-20251001', { inputTokens: 1_000_000, outputTokens: 0 }),
    ).toBeCloseTo(1);
    expect(
      usdFor('deepgram', 'nova-3/hi', { inputTokens: 0, outputTokens: 0, audioSec: 600 }),
    ).toBeCloseTo(0.056);
  });

  it('counts Claude, not Deepgram or free-tier Gemini', async () => {
    await recordSpend('claude', 1.25);
    await recordSpend('deepgram', 3);
    await recordSpend('gemini', 2);
    expect(await spentUsd()).toBeCloseTo(1.25);
  });

  it('refuses a call that would cross the cap, as a fatal (non-retried) error', async () => {
    await recordSpend('claude', 4.95);
    await expect(assertBudget('claude', 0.01)).resolves.toBeUndefined();
    const err = await assertBudget('claude', 0.1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(classify(err)).toBeInstanceOf(FatalError);
    expect((err as Error).message).toContain('$5.00 cap');
    await expect(assertBudget('deepgram', 100)).resolves.toBeUndefined();
  });

  it('counts Gemini once GEMINI_PAID is true', async () => {
    process.env.GEMINI_PAID = 'true';
    resetEnvCache();
    await recordSpend('gemini', 0.5);
    expect(await spentUsd()).toBeCloseTo(0.5);
    process.env.GEMINI_PAID = 'false';
    resetEnvCache();
  });
});
