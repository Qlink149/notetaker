import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { requireEnv } from '../../config/env.js';

// Backfill the speaker fields the global assign page reads, and drop the unique name index so two
// people can share a spelling (they are told apart by id, email or role).
//
// Dry run unless --apply. Does not merge anyone, does not rewrite meetings, and does not delete a
// voice. Case-insensitive duplicate names are only reported.
//
// Do not run this against production data until it has been reviewed.
//
//   npm run migrate:speaker-fields -w @meetingid/api -- [--uri-env MONGODB_URI] [--db meetingid] [--apply]
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'uri-env': { type: 'string', default: 'MONGODB_URI' },
      db: { type: 'string', default: '' },
      apply: { type: 'boolean' },
    },
  });
  const uri = process.env[values['uri-env']!] ?? requireEnv('MONGODB_URI');
  await mongoose.connect(uri, values.db ? { dbName: values.db } : {});
  const speakers = mongoose.connection.db!.collection('speakers');
  const missing = await speakers.countDocuments({
    $or: [{ email: { $exists: false } }, { role: { $exists: false } }, { leftAt: { $exists: false } }],
  });
  console.log(`${missing} speaker profile(s) missing email, role or leftAt`);

  const names = await speakers
    .find({}, { projection: { name: 1, workspaceId: 1, email: 1, role: 1 } })
    .toArray();
  const groups = new Map<string, { name: string; email: unknown; role: unknown }[]>();
  for (const doc of names) {
    const key = `${String(doc.workspaceId)}:${String(doc.name).trim().toLowerCase()}`;
    const list = groups.get(key) ?? [];
    list.push({ name: String(doc.name), email: doc.email ?? null, role: doc.role ?? null });
    groups.set(key, list);
  }
  const dupes = [...groups.values()].filter((g) => g.length > 1);
  console.log(`${dupes.length} case-insensitive duplicate name group(s) (not merged)`);
  for (const g of dupes) console.log(` - ${g.map((p) => `${p.name} <${p.email ?? p.role ?? ''}>`).join(' | ')}`);

  const indexes = await speakers.indexes();
  const unique = indexes.find((i) => i.name === 'workspaceId_1_name_1' && i.unique);
  console.log(
    unique
      ? 'unique index workspaceId_1_name_1 is still in place'
      : 'no unique name index',
  );

  if (!values.apply) {
    console.log('dry run — nothing written. Pass --apply to backfill nulls and drop the unique index.');
    await mongoose.disconnect();
    return;
  }

  if (missing) {
    const email = await speakers.updateMany({ email: { $exists: false } }, { $set: { email: null } });
    const role = await speakers.updateMany({ role: { $exists: false } }, { $set: { role: null } });
    const left = await speakers.updateMany({ leftAt: { $exists: false } }, { $set: { leftAt: null } });
    console.log(
      `backfilled email ${email.modifiedCount}, role ${role.modifiedCount}, leftAt ${left.modifiedCount}`,
    );
  }
  if (unique) {
    await speakers.dropIndex('workspaceId_1_name_1');
    await speakers.createIndex({ workspaceId: 1, name: 1 });
    console.log('dropped unique name index and created a non-unique one');
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
