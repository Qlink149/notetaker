/** Haiku 4.5 rejects the `effort` setting; the Sonnet, Opus and later models accept it. */
export const supportsEffort = (model: string): boolean => !/haiku/i.test(model);

/**
 * Models that think before answering count that thinking against max_tokens, so they get twice the room. It is a
 * ceiling, not a cost. Haiku does not think.
 */
export const tokenLimit = (model: string, base: number): number =>
  supportsEffort(model) ? base * 2 : base;

/** Attempts at a complete, valid summary before the best incomplete one is repaired and saved. */
export const MAX_SUMMARY_ATTEMPTS = 3;

/** Output tokens the summary call may use (the cap, with room for thinking on models that think). */
export const SUMMARY_MAX_OUTPUT_TOKENS = 8000;
