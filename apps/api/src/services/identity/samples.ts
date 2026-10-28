import { createHash } from 'node:crypto';
import type { VoiceprintDoc } from '../../models/index.js';

/**
 * What the browser calls one voice sample. A sample has no id of its own, and the `id` of an old recorded one is
 * the voiceprint itself, so neither is ever sent out: this is a short hash of it, enough to tell one sample of a
 * person from another.
 */
export const sampleKey = (v: Pick<VoiceprintDoc, 'id'>): string =>
  createHash('sha256').update(`sample:${v.id}`).digest('hex').slice(0, 16);

/** A sample that is still compared with new voices. */
export const isActiveSample = (v: Pick<VoiceprintDoc, 'removedAt'>): boolean => !v.removedAt;
