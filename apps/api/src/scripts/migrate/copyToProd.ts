import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { trimOutput } from '../../services/pyannote/output.js';

// Copy the app's data from the current database (MONGODB_URI / MONGODB_DB) into the production database
// (MONGODB_URI_PROD, database --to-db). Additive and safe to repeat: a document that already exists in
// the destination (same _id) is never overwritten; nothing is ever deleted; only the collections below
// are touched, and only inside the destination database (the production cluster is shared with many other
// databases that this script never reads or writes). Dry run unless --apply.
//
//   npm run migrate:copy -w @meetingid/api -- [--to-db meetingid_prod] [--apply]
const COLLECTIONS = [
  'workspaces',
  'glossaries',
  'speakers',
  'meetings',
  'meetingdata',
  'engineresponses',
  'spend',
  'p2_pyannote_responses',
  'p2_identity_runs',
  'p2_audits',
  'p2_join_lines',
];
// not copied: finished job queue, worker heartbeats, Gemini quota records, summary hand-offs (test
// artifacts), cached pyannote media addresses (expired), empty collections
const hostOf = (uri: string): string => /@([^/?]+)/.exec(uri)?.[1] ?? uri.slice(0, 40);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { 'to-db': { type: 'string', default: 'meetingid_prod' }, apply: { type: 'boolean' } },
  });
  const toUri = process.env.MONGODB_URI_PROD;
  if (!toUri) throw new Error('MONGODB_URI_PROD is not set');
  const toName = values['to-db']!;
  const fromName = env().MONGODB_DB;
  if (hostOf(toUri) === hostOf(env().MONGODB_URI) && toName === fromName)
    throw new Error('source and destination are the same database');

  const from = await mongoose.createConnection(env().MONGODB_URI, { serverSelectionTimeoutMS: 20000 }).asPromise();
  const to = await mongoose.createConnection(toUri, { serverSelectionTimeoutMS: 20000 }).asPromise();
  const src = from.getClient().db(fromName);
  const dst = to.getClient().db(toName);
  console.log(`${hostOf(env().MONGODB_URI)}/${fromName}  ->  ${hostOf(toUri)}/${toName}  (${values.apply ? 'APPLYING' : 'dry run'})`);

  // the destination must be new, or contain only our own collections
  const existing = (await dst.listCollections().toArray()).map((c) => c.name);
  const foreign = existing.filter((n) => !COLLECTIONS.includes(n) && !n.startsWith('system.'));
  if (foreign.length)
    throw new Error(`database "${toName}" already has collections that are not ours (${foreign.join(', ')}); pick another --to-db`);

  let total = 0;
  for (const name of COLLECTIONS) {
    const docs = await src.collection(name).find().toArray();
    if (!docs.length) {
      console.log(`${name.padEnd(24)} 0 documents`);
      continue;
    }
    const have = new Set((await dst.collection(name).find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));
    const fresh = docs.filter((d) => !have.has(String(d._id)));
    const copy = fresh.map((d) =>
      name === 'p2_pyannote_responses' && d.output ? { ...d, output: trimOutput(d.output) } : d,
    );
    console.log(`${name.padEnd(24)} ${String(docs.length).padStart(4)} in the source, ${String(have.size).padStart(4)} already in the destination, ${String(fresh.length).padStart(4)} to copy`);
    if (values.apply && copy.length) {
      for (let i = 0; i < copy.length; i += 100)
        await dst.collection(name).insertMany(copy.slice(i, i + 100), { ordered: false });
      total += copy.length;
    }
  }
  if (values.apply) {
    console.log(`\ncopied ${total} documents. Counts now (source -> destination):`);
    for (const name of COLLECTIONS) {
      const a = await src.collection(name).countDocuments();
      const b = await dst.collection(name).countDocuments();
      console.log(`  ${name.padEnd(24)} ${String(a).padStart(4)} -> ${String(b).padStart(4)} ${a === b ? 'ok' : 'DIFFERENT'}`);
    }
  } else console.log('\nnothing written (dry run). Add --apply to copy.');
  await from.close();
  await to.close();
}

main().catch((err: unknown) => {
  console.error(String((err as Error).message ?? err).replace(/(mongodb(\+srv)?:\/\/)[^@\s]+@/g, '$1***@'));
  process.exit(1);
});
