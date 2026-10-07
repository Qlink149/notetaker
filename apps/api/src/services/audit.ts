import { Types } from 'mongoose';
import { seededRandom, shuffled, stratifiedSample } from '@meetingid/pipeline';
import type { Line } from '@meetingid/shared';
import { P2AuditModel, P2JoinModel, type AuditItem } from '../models/phase2.js';

/**
 * Sample lines from the M1 and M3 joins of a meeting (a third under 3 s), hide the method and
 * shuffle. Stable per meeting. Returns the number of items.
 */
export async function seedAudit(
  meetingId: string,
  workspaceId: Types.ObjectId,
  perMethod: number,
): Promise<number> {
  const m = { _id: new Types.ObjectId(meetingId) };
  const items: AuditItem[] = [];
  for (const method of ['m1', 'm3'] as const) {
    const join = await P2JoinModel.findOne({ meetingId: m._id, method }).lean();
    if (!join) continue;
    const labelToDiar = Object.fromEntries(
      Object.entries(join.speakerMap).map(([diar, label]) => [label, diar]),
    );
    const lines = (join.lines as Line[]).filter(
      (l) => l.textRoman.trim() && l.end - l.start >= 0.4 && labelToDiar[l.speakerName],
    );
    const pick = stratifiedSample(lines, perMethod, seededRandom(`${m._id}:${method}`));
    pick.forEach((l, k) =>
      items.push({
        id: `${method}-${k}`,
        method,
        start: l.start,
        end: l.end,
        diar: labelToDiar[l.speakerName]!,
        textRoman: l.textRoman,
        textNative: l.textNative,
        short: l.end - l.start < 3,
        speaker: null,
        text: null,
        answeredAt: null,
      }),
    );
  }
  const order = shuffled(items, seededRandom(`${m._id}:order`));
  await P2AuditModel.updateOne(
    { meetingId: m._id },
    {
      $set: { items: order, perMethod },
      $setOnInsert: { workspaceId, naming: {}, sameAs: {}, createdAt: new Date() },
    },
    { upsert: true },
  );
  return order.length;
}
