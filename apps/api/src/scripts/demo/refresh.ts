import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { TEST_MEETINGS } from '../phase2/lib.js';

// Re-copy chosen meetings from the Phase 1 database into the demo database once the Phase 1 queue
// has finished them (Prachar's last chunks, gap-filled AOM / 21-9). The Phase 1 database is only
// read. The copies start again from Phase 1's transcript: run the pipeline over them afterwards.
//   npm run demo:refresh -w @meetingid/api -- Prachar [AOM 21-9 200] [--apply]
// then: npm run p2:join -- <names>; npm run demo:reprocess -- <ids>; answer the summary handoffs;
//       npm run demo:reprocess -- --resume; npm run demo:snapshot
const TITLES: Record<string, string> = {
  '21-9': 'Meeting 21/9',
  '200': '200',
  AOM: 'AOM Meeting part 1',
  Prachar: 'Prachar',
};

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { apply: { type: 'boolean' }, from: { type: 'string', default: 'meetingid' } },
  });
  const cfg = env();
  if (!cfg.MONGODB_DB.endsWith('_demo'))
    throw new Error('refresh writes to the _demo database only');
  await mongoose.connect(cfg.MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });
  const client = mongoose.connection.getClient();
  const src = client.db(values.from);
  const dst = client.db(cfg.MONGODB_DB);
  console.log(`${values.from} -> ${cfg.MONGODB_DB}; ${values.apply ? 'APPLYING' : 'dry run'}`);
  for (const name of positionals) {
    const id = (TEST_MEETINGS as Record<string, string>)[name];
    if (!id) throw new Error(`unknown meeting "${name}" (use 21-9, 200, AOM or Prachar)`);
    const _id = new mongoose.Types.ObjectId(id);
    const meeting = await src.collection('meetings').findOne({ _id });
    const data = await src.collection('meetingdata').findOne({ meetingId: _id });
    if (!meeting || !data) {
      console.log(`${name}: not found in ${values.from}`);
      continue;
    }
    const chunks = (data['chunks'] as { status: string }[]) ?? [];
    const done = chunks.filter((c) => c.status === 'done').length;
    console.log(
      `${name}: Phase 1 says status ${String(meeting['status'])}/${String(meeting['stage'])}, chunks ${done}/${chunks.length} done, ` +
        `${(data['turns'] as unknown[])?.length ?? 0} turns, gap fills ${(data['gapFills'] as unknown[])?.length ?? 0}`,
    );
    if (values.apply) {
      await dst
        .collection('meetings')
        .replaceOne(
          { _id },
          { ...meeting, title: TITLES[name] ?? meeting['title'] },
          { upsert: true },
        );
      await dst.collection('meetingdata').replaceOne({ meetingId: _id }, data, { upsert: true });
    }
  }
  await mongoose.disconnect();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
