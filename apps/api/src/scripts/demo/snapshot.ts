import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { copyDatabase } from './copyDb.js';

// Save the demo database as it is now (the finished demo state) into <db>_snapshot so that
// `npm run demo:reset` can bring it back. Collections that only matter while a demo runs (job queue,
// heartbeats, live group-recording sessions) are not saved.
//   npm run demo:snapshot -w @meetingid/api
async function main(): Promise<void> {
  parseArgs({ options: {} });
  const cfg = env();
  await mongoose.connect(cfg.MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });
  const from = cfg.MONGODB_DB;
  if (!from.endsWith('_demo'))
    throw new Error(`snapshot is for the _demo database (MONGODB_DB is "${from}")`);
  const to = `${from}_snapshot`;
  const client = mongoose.connection.getClient();
  const all = (await client.db(from).listCollections().toArray()).map((c) => c.name);
  const skip = new Set([
    'jobs',
    'workerheartbeats',
    'meetingsessions',
    'sessionparticipants',
    'sessionloudness',
  ]);
  // the snapshot is replaced as a whole: clear its documents first so removed items do not linger
  for (const c of await client.db(to).listCollections().toArray())
    await client.db(to).collection(c.name).deleteMany({});
  const copied = await copyDatabase(
    from,
    to,
    all.filter((n) => !skip.has(n) && !n.startsWith('system.')),
  );
  console.log(
    `snapshot written to ${to}: ${Object.values(copied).reduce((a, b) => a + b, 0)} documents in ${Object.keys(copied).length} collections`,
  );
  await mongoose.disconnect();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
