import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { restoreDatabase } from './copyDb.js';

// Put the demo database back to the saved demo state (npm run demo:snapshot), one command.
// Stop `npm run demo` first if you can; it works either way. Removes anything created during a
// demo (renames, new recordings, group sessions) from the _demo database only.
//   npm run demo:reset -w @meetingid/api
async function main(): Promise<void> {
  parseArgs({ options: {} });
  const cfg = env();
  await mongoose.connect(cfg.MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });
  const target = cfg.MONGODB_DB;
  if (!target.endsWith('_demo'))
    throw new Error(`reset is for the _demo database (MONGODB_DB is "${target}")`);
  const snapshot = `${target}_snapshot`;
  const client = mongoose.connection.getClient();
  const have = (await client.db(snapshot).listCollections().toArray()).length;
  if (!have) throw new Error(`no snapshot found (${snapshot}). Run: npm run demo:snapshot`);
  await restoreDatabase(snapshot, target);
  console.log(`\n${target} restored from ${snapshot}.`);
  await mongoose.disconnect();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
