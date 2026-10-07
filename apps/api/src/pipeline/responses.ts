import type { Types } from 'mongoose';
import { normalizeChunkTurns } from '@meetingid/pipeline';
import type { Turn } from '@meetingid/shared';
import { EngineResponseModel, type EngineResponseDoc } from '../models/index.js';
import { parseTranscriptJson } from '../services/engines/gemini.js';
import type { EngineRawResponse } from '../services/engines/types.js';

/**
 * Store an engine reply untouched (DECISIONS #25). Called for every reply that arrives, whether
 * it is used, truncated or unparseable, so nothing paid for is lost. Returns its id, or null when
 * the engine gave no raw reply (Deepgram, test fakes).
 */
export async function saveEngineResponse(
  raw: EngineRawResponse | null | undefined,
  where: {
    meetingId: Types.ObjectId;
    kind: EngineResponseDoc['kind'];
    chunkIndex?: number | null;
    startSec: number;
    endSec: number;
  },
  error: string | null = null,
): Promise<Types.ObjectId | null> {
  if (!raw) return null;
  const doc = await EngineResponseModel.create({
    ...raw,
    meetingId: where.meetingId,
    kind: where.kind,
    chunkIndex: where.chunkIndex ?? null,
    startSec: where.startSec,
    endSec: where.endSec,
    error,
  });
  return doc._id;
}

/** Rebuild cleaned, absolute-time turns from a stored reply: no engine call, no quota. */
export function turnsFromStoredResponse(
  doc: Pick<EngineResponseDoc, 'text' | 'startSec' | 'endSec'>,
): Turn[] {
  return normalizeChunkTurns(
    parseTranscriptJson(doc.text ?? undefined),
    doc.endSec - doc.startSec,
    doc.startSec,
  );
}
