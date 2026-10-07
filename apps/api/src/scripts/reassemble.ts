import { AnonymousResolver } from '@meetingid/pipeline';
import { env } from '../config/env.js';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { MeetingDataModel, MeetingModel } from '../models/index.js';
import { rebuildTranscript } from '../pipeline/transcript.js';

// Re-run assembly (chunks + stored gap fills) without engine calls and keep the existing summary:
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
    const built = await rebuildTranscript(m, d, new AnonymousResolver());
    console.log(
      JSON.stringify({
        meeting: m.title,
        before,
        after: {
          speakers: built.speakerCount,
          lines: built.lines.length,
          coverage: built.coverage.ratio,
        },
        gapFills: (d.gapFills ?? []).filter((g) => g.status === 'done').length,
        seams: built.seams.map((s) => ({ drift: s.driftSec, anchors: s.anchors })),
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
