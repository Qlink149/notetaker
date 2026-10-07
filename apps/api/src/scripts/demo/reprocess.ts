import { parseArgs } from 'node:util';
import { connectMongo, disconnectMongo } from '../../db/mongo.js';
import { env } from '../../config/env.js';
import { JobModel, MeetingModel } from '../../models/index.js';
import { defaultDeps } from '../../pipeline/context.js';
import { enqueue } from '../../pipeline/queue.js';
import { Runner } from '../../pipeline/runner.js';
import { stages } from '../../pipeline/stages/index.js';

// Run meetings through the new stages (assemble with the pyannote join -> identify -> summarise ->
// finalise) from STORED output only. This process cannot call Gemini: the keys are removed from its
// environment and gap-fill is switched off, so the number of new Gemini calls is zero by construction.
// Summaries use the handoff provider: when they are waiting for an answer the script stops and lists them.
//   npm run demo:reprocess -w @meetingid/api -- <meetingId>... [--resume]
for (const name of Object.keys(process.env))
  if (/^GEMINI_API_KEY\d*$/.test(name)) delete process.env[name];
process.env.GAPFILL = 'off';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { resume: { type: 'boolean' } },
  });
  const cfg = env();
  await connectMongo(cfg.MONGODB_URI, cfg.MONGODB_DB);
  if (!cfg.MONGODB_DB.endsWith('_demo'))
    throw new Error('reprocess is for the _demo database only');
  const deps = defaultDeps();
  console.log(
    `speaker source: ${deps.speakerSource}; summaries: ${cfg.SUMMARY_PROVIDER}; gemini keys in this process: 0`,
  );

  if (!values.resume) {
    for (const id of positionals) {
      const m = await MeetingModel.findByIdAndUpdate(id, {
        $set: { stage: 'assemble', status: 'processing', error: null },
      }).lean();
      if (!m) {
        console.log(`${id}: not found`);
        continue;
      }
      await enqueue({ meetingId: m._id, stage: 'assemble' });
      console.log(`${m.title}: assemble queued`);
    }
  }
  const runner = new Runner(deps, stages, { workerId: 'demo-reprocess', concurrency: 1 });
  for (let i = 0; i < 40; i++) {
    await runner.drain();
    const queued = await JobModel.find({ status: 'queued' }).lean();
    if (!queued.length) break;
    // summaries wait for the subagent's answer; everything else just waits to be polled again
    await JobModel.updateMany(
      {
        status: 'queued',
        ...(queued.every((j) => j.stage === 'summarise') ? {} : { stage: { $ne: 'summarise' } }),
      },
      { $set: { runAfter: new Date(0) } },
    );
    if (queued.every((j) => j.stage === 'summarise')) {
      await runner.drain();
      break;
    }
  }
  const left = await JobModel.find({ status: { $ne: 'done' } }).lean();
  console.log(
    left.length
      ? `waiting: ${left.map((j) => `${j.stage}/${String(j.meetingId).slice(-4)}`).join(', ')}`
      : 'all jobs done',
  );
  await disconnectMongo();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await disconnectMongo().catch(() => undefined);
  process.exit(1);
});
