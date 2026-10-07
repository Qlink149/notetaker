import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { connectMongo, disconnectMongo } from '../../db/mongo.js';
import { MeetingDataModel, MeetingModel } from '../../models/index.js';

// Tidy a COPY of the Phase 1 data for the demo: drop test clips and the superseded 21-9 run, and
// give the four recordings client-friendly titles. Refuses to touch any database whose name does
// not end in "_demo". Dry run unless --apply.
//   npm run demo:prepare -w @meetingid/api -- [--apply]

const NOISE = [/^clip /i, /^Meeting-21-9-2026 \(acceptance\)$/];
const TITLES: [RegExp, string][] = [
  [/21-9/, 'Meeting 21/9'],
  [/^AOM/, 'AOM Meeting part 1'],
  [/^200/, '200'],
  [/^Prachar/, 'Prachar'],
];

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' } } });
  const cfg = env();
  await connectMongo(cfg.MONGODB_URI, cfg.MONGODB_DB);
  const dbName = mongoose.connection.name;
  if (!dbName.endsWith('_demo'))
    throw new Error(`refusing to modify "${dbName}": not a _demo database`);
  console.log(`database ${dbName}; ${values.apply ? 'APPLYING' : 'dry run'}`);

  const meetings = await MeetingModel.find({}, { title: 1 }).lean();
  for (const m of meetings) {
    if (NOISE.some((re) => re.test(m.title))) {
      console.log(`remove  ${String(m._id).slice(-4)}  ${m.title}`);
      if (values.apply) {
        await MeetingDataModel.deleteOne({ meetingId: m._id });
        await MeetingModel.deleteOne({ _id: m._id });
      }
      continue;
    }
    const title = TITLES.find(([re]) => re.test(m.title))?.[1];
    if (title && title !== m.title) {
      console.log(`rename  ${String(m._id).slice(-4)}  "${m.title}" -> "${title}"`);
      if (values.apply) await MeetingModel.updateOne({ _id: m._id }, { $set: { title } });
    }
  }
  await disconnectMongo();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await disconnectMongo().catch(() => undefined);
  process.exit(1);
});
