import {
  AnonymousResolver,
  assembleChunks,
  computeCoverage,
  turnsToLines,
} from '@meetingid/pipeline';
import type { Turn } from '@meetingid/shared';
import { env } from '../config/env.js';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { MeetingDataModel, MeetingModel } from '../models/index.js';
import { MAX_LINE_SEC, PAUSE_SEC } from '../pipeline/stages/30-assemble.js';

// Re-run assembly from stored chunk turns (no engine calls) and keep the existing summary:
//   npm run reassemble -w @meetingid/api -- <meetingId> [...]
// Prints speakers / lines / coverage before and after.
async function main(): Promise<void> {
  const cfg = env();
  await connectMongo(cfg.MONGODB_URI, cfg.MONGODB_DB);
  for (const id of process.argv.slice(2)) {
    const m = await MeetingModel.findById(id).lean();
    const d = await MeetingDataModel.findOne({ meetingId: id }).lean();
    if (!m || !d) continue;
    const before = {
      speakers: new Set(d.lines.map((l) => l.speakerName)).size,
      lines: d.lines.length,
      coverage: m.coverage?.ratio,
    };
    const done = d.chunks.filter((c) => c.status === 'done');
    const { turns, speakerCount, seams } = assembleChunks(
      done.map((c) => ({ startSec: c.startSec, endSec: c.endSec, turns: c.rawTurns as Turn[] })),
    );
    const res = await new AnonymousResolver().resolve({ turns, analysisUrl: null });
    const lines = turnsToLines(turns, res.speakerMap, {
      maxLineSec: MAX_LINE_SEC,
      pauseSec: PAUSE_SEC,
    });
    const coverage = computeCoverage(d.speechSegments, turns);
    await MeetingDataModel.updateOne(
      { meetingId: m._id },
      { $set: { turns, lines, speakerMap: res.speakerMap } },
    );
    await MeetingModel.updateOne(
      { _id: m._id },
      { $set: { coverage, unknownCount: res.unknownCount } },
    );
    console.log(
      JSON.stringify({
        meeting: m.title,
        before,
        after: { speakers: speakerCount, lines: lines.length, coverage: coverage.ratio },
        seams: seams.map((s) => ({ drift: s.driftSec, anchors: s.anchors })),
      }),
    );
  }
  await disconnectMongo();
}

main().catch(async (err: unknown) => {
  console.error(err);
  await disconnectMongo().catch(() => undefined);
  process.exit(1);
});
