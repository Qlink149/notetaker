import { env } from '../config/env.js';
import { SpendModel } from '../models/index.js';
import { FatalError } from './errors.js';

// Published paid-tier prices (read 2026-10-07):
// - Gemini: https://ai.google.dev/gemini-api/docs/pricing — 3.8 Flash $0.75 in / $3.75 out per 1M tokens
//   (promotional through 2026-12-31; $1.50 / $7.50 from 2027-01-01), 3.5 Flash $1.50 / $9.00,
//   3.5 Transcribe $2.00 / $12.00.
// - Claude Haiku 4.5: $1 in / $5 out per 1M tokens.
// - Deepgram Nova-3 pre-recorded: $0.0043/min + keyterm prompting $0.0013/min.
const PER_M: Record<string, { in: number; out: number }> = {
  'gemini-3.8-flash': { in: 0.75, out: 3.75 },
  'gemini-3.5-flash': { in: 1.5, out: 9 },
  'gemini-3.5-transcribe': { in: 2, out: 12 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
};
const DEEPGRAM_PER_MIN = 0.0043 + 0.0013;
/** Unknown models are priced like the most expensive Gemini model above, to stay on the safe side. */
const FALLBACK = { in: 2, out: 12 };

export type Provider = 'gemini' | 'claude' | 'deepgram';

export function usdFor(
  provider: Provider,
  model: string,
  usage: { inputTokens: number; outputTokens: number; audioSec?: number },
): number {
  if (provider === 'deepgram') return ((usage.audioSec ?? 0) / 60) * DEEPGRAM_PER_MIN;
  const p = PER_M[model.replace(/\/.*$/, '')] ?? FALLBACK;
  return (usage.inputTokens * p.in + usage.outputTokens * p.out) / 1_000_000;
}

/** Whether a provider's spend counts against the cap (Deepgram is excluded; free-tier Gemini costs nothing). */
function capped(provider: Provider): boolean {
  if (provider === 'deepgram') return false;
  if (provider === 'gemini') return env().GEMINI_PAID;
  return true;
}

export class BudgetExceededError extends FatalError {
  constructor(spent: number, estimate: number, cap: number) {
    super(
      `Spending cap reached: $${spent.toFixed(2)} spent of the $${cap.toFixed(2)} cap; this step needs about $${estimate.toFixed(2)}. Raise SPEND_CAP_USD to continue.`,
    );
  }
}

export async function spentUsd(): Promise<number> {
  return (await SpendModel.findById('total').lean())?.usd ?? 0;
}

/** Refuse a paid call that could push recorded spend over SPEND_CAP_USD. */
export async function assertBudget(provider: Provider, estimateUsd: number): Promise<void> {
  if (!capped(provider)) return;
  const cap = env().SPEND_CAP_USD;
  const spent = await spentUsd();
  if (spent + estimateUsd > cap) throw new BudgetExceededError(spent, estimateUsd, cap);
}

export async function recordSpend(provider: Provider, usd: number): Promise<void> {
  if (!capped(provider) || !(usd > 0)) return;
  await SpendModel.updateOne(
    { _id: 'total' },
    { $inc: { usd, [`byProvider.${provider}`]: usd }, $set: { updatedAt: new Date() } },
    { upsert: true },
  );
}

/** Rough upper estimate for one Gemini chunk call: 32 audio tokens/s in, generous output. */
export const estimateGeminiChunkUsd = (model: string, seconds: number): number =>
  usdFor('gemini', model, { inputTokens: seconds * 32 + 2_000, outputTokens: 40_000 });

/** Rough upper estimate for the summary: ~4 chars per token in, 8k tokens out, ×2 for one retry. */
export const estimateClaudeUsd = (model: string, transcriptChars: number): number =>
  2 * usdFor('claude', model, { inputTokens: transcriptChars / 4 + 2_000, outputTokens: 8_000 });
