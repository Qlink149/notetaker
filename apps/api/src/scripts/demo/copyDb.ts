import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { env } from '../../config/env.js';

// Copy the demo data from the Phase 1 database into the demo database (upsert by _id; the source
// is only read, nothing is deleted anywhere). Also used by scripts/demo/reset-demo.
//   npm run demo:copy -w @meetingid/api -- [--from meetingid] [--to meetingid_demo] [--only a,b]
//
// `jobs` and `workerheartbeats` are never copied: queued Phase 1 jobs would make a demo worker
// spend Gemini quota. The demo database gets its own queue.

const DEFAULT_COLLECTIONS = [
  'workspaces',
  'meetings',
  'meetingdata',
  'engineresponses',
  'glossaries',
  'speakers',
  'summaryhandoffs',
  'geminiquotas',
  'spend',
  'p2_pyannote_responses',
  'p2_media',
  'p2_join_lines',
  'p2_audits',
];
const NEVER_COPY = new Set(['jobs', 'workerheartbeats']);

export async function copyDatabase(
  from: string,
  to: string,
  only: string[] = DEFAULT_COLLECTIONS,
  log = console.log,
): Promise<Record<string, number>> {
  if (from === to) throw new Error('source and target database must differ');
  const client = mongoose.connection.getClient();
  const src = client.db(from);
  const dst = client.db(to);
  const existing = new Set((await src.listCollections().toArray()).map((c) => c.name));
  const copied: Record<string, number> = {};
  for (const name of only) {
    if (NEVER_COPY.has(name)) throw new Error(`${name} must not be copied`);
    if (!existing.has(name)) continue;
    const docs = await src.collection(name).find({}).toArray();
    for (let i = 0; i < docs.length; i += 200) {
      const batch = docs.slice(i, i + 200);
      await dst.collection(name).bulkWrite(
        batch.map((d) => ({
          replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true },
        })),
        { ordered: false },
      );
    }
    copied[name] = docs.length;
    log(`${name}: ${docs.length}`);
  }
  return copied;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      from: { type: 'string', default: 'meetingid' },
      to: { type: 'string', default: 'meetingid_demo' },
      only: { type: 'string' },
    },
  });
  await mongoose.connect(env().MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });
  await copyDatabase(values.from, values.to, values.only?.split(','));
  await mongoose.disconnect();
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  main().catch(async (err: unknown) => {
    console.error(err);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
  });
}

/**
 * Make `to` identical to `from` (documents replaced, extra documents removed, collections kept).
 * Only ever applied to a database whose name ends in "_demo". Worker heartbeats are left alone, and
 * the job queue is emptied so a restored demo never resumes half-finished work.
 */
export async function restoreDatabase(
  from: string,
  to: string,
  log = console.log,
): Promise<Record<string, { restored: number; removed: number }>> {
  if (!to.endsWith('_demo'))
    throw new Error(`refusing to restore into "${to}": not a _demo database`);
  if (from === to) throw new Error('source and target database must differ');
  const client = mongoose.connection.getClient();
  const src = client.db(from);
  const dst = client.db(to);
  const names = new Set([
    ...(await src.listCollections().toArray()).map((c) => c.name),
    ...(await dst.listCollections().toArray()).map((c) => c.name),
  ]);
  names.delete('workerheartbeats');
  names.delete('jobs');
  const report: Record<string, { restored: number; removed: number }> = {};
  for (const name of [...names].filter((n) => !n.startsWith('system.'))) {
    const docs = await src.collection(name).find({}).toArray();
    for (let i = 0; i < docs.length; i += 200) {
      await dst.collection(name).bulkWrite(
        docs
          .slice(i, i + 200)
          .map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
        { ordered: false },
      );
    }
    const removed = await dst
      .collection(name)
      .deleteMany({ _id: { $nin: docs.map((d) => d._id) } });
    report[name] = { restored: docs.length, removed: removed.deletedCount };
    log(`${name}: ${docs.length} restored, ${removed.deletedCount} removed`);
  }
  const jobs = await dst.collection('jobs').deleteMany({});
  log(`jobs: queue emptied (${jobs.deletedCount})`);
  return report;
}
