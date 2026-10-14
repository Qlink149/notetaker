import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';
import {
  BudgetExceededError,
  assertBudget,
  recordSpend,
  estimateClaudeUsd,
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
      usdFor('claude', 'claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBeCloseTo(12);
    expect(
      usdFor('deepgram', 'nova-3/hi', { inputTokens: 0, outputTokens: 0, audioSec: 600 }),
    ).toBeCloseTo(0.056);
  });

  it('the summary estimate covers every attempt and the thinking room of models that think', () => {
    // 100,000 characters: about 28,000 tokens in per attempt, three attempts
    expect(estimateClaudeUsd('claude-haiku-4-5', 100_000)).toBeCloseTo(3 * (0.028 + 0.04), 3);
    expect(estimateClaudeUsd('claude-sonnet-5-5', 100_000)).toBeCloseTo(3 * (0.056 + 0.16), 3);
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
