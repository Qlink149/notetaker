import { describe, expect, it } from 'vitest';
import {
  CREDIT_WAIT_MS,
  RetryableError,
  classify,
  humanizeError,
  isOutOfCredit,
} from '../src/pipeline/errors.js';

// 19 Oct: Gemini's prepaid credit ran out twice. The 402 was treated as a broken request, so meetings failed
// at once and the page said "a quota or rate limit was hit, try again in a few minutes".
const depleted = Object.assign(
  new Error(
    '{"error":{"code":402,"message":"Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing."}}',
  ),
  { status: 402 },
);

describe('provider credit used up', () => {
  it('is a wait, not a failure, and does not count as an attempt', () => {
    const err = classify(depleted);
    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).reason).toBe('quota');
    expect((err as RetryableError).retryAfterMs).toBe(CREDIT_WAIT_MS);
  });

  it('is recognised by status, by the classified message, and by Google’s wording', () => {
    expect(isOutOfCredit(depleted)).toBe(true);
    expect(isOutOfCredit(classify(depleted))).toBe(true);
    expect(isOutOfCredit(new Error('402 API error occurred: {"httpMeta":{}}'))).toBe(false);
    expect(isOutOfCredit(Object.assign(new Error('402 API error occurred'), { status: 402 }))).toBe(
      true,
    );
  });

  it('tells the client the real reason and that nothing needs doing', () => {
    const msg = humanizeError(classify(depleted));
    expect(msg).toMatch(/run out of credit/);
    expect(msg).toMatch(/continues automatically/);
    expect(msg).not.toMatch(/rate limit/);
  });

  it('leaves other errors alone (a 404 stays a failure, a 429 stays a rate limit, "402" in text is not credit)', () => {
    expect(classify(Object.assign(new Error('not found'), { status: 404 }))).not.toBeInstanceOf(
      RetryableError,
    );
    expect(humanizeError(new Error('429 Too Many Requests'))).toMatch(/rate limit/);
    expect(isOutOfCredit(new Error('chunk 402 of the meeting failed'))).toBe(false);
  });
});
