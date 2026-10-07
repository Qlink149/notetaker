import { JobStage } from '@meetingid/shared';
import { env } from '../config/env.js';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { MeetingModel } from '../models/index.js';
import { enqueue } from '../pipeline/queue.js';

// Re-run a meeting from one stage on (the worker picks it up):
//   npm run requeue -w @meetingid/api -- gapfill <meetingId> [...]
async function main(): Promise<void> {
  const [stageArg, ...ids] = process.argv.slice(2);
  const stage = JobStage.parse(stageArg);
  if (stage === 'benchmark' || !ids.length)
    throw new Error('usage: requeue <stage> <meetingId>...');
  const cfg = env();
  await connectMongo(cfg.MONGODB_URI, cfg.MONGODB_DB);
  for (const id of ids) {
    const m = await MeetingModel.findByIdAndUpdate(id, {
      $set: { stage, status: 'processing', error: null },
    }).lean();
    if (!m) {
      console.log(`${id}: not found`);
      continue;
    }
    await enqueue({ meetingId: m._id, stage });
    console.log(`${id} (${m.title}): queued ${stage}`);
  }
  await disconnectMongo();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await disconnectMongo().catch(() => undefined);
  process.exit(1);
});
