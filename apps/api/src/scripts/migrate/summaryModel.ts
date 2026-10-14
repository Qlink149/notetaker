import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { DEFAULT_SUMMARY_MODEL } from '@meetingid/shared';
import { requireEnv } from '../../config/env.js';

// Move workspaces that still use the old default summary model (Claude Haiku) to the current default. The model is
// stored per workspace when the workspace is created, so changing the default in code does not reach existing ones.
// Only workspaces whose model starts with "claude-haiku" are touched; a model someone chose on purpose is left alone.
// Run it AFTER the version that sends the right settings for the new model (effort, token room) is deployed.
// Dry run unless --apply.
//
//   npm run migrate:summary-model -w @meetingid/api -- [--uri-env MONGODB_URI_PROD] [--db meetingid_prod] [--apply]
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
  const workspaces = mongoose.connection.db!.collection('workspaces');
  const old = await workspaces
    .find({ 'settings.summaryModel': { $regex: '^claude-haiku' } })
    .project({ slug: 1, 'settings.summaryModel': 1 })
    .toArray();
  console.log(
    `${old.length} workspace(s) on a Haiku summary model; target ${DEFAULT_SUMMARY_MODEL}`,
  );
  for (const w of old)
    console.log(
      ` - ${String(w.slug)}: ${String(w.settings?.summaryModel)} -> ${DEFAULT_SUMMARY_MODEL}`,
    );
  if (values.apply && old.length) {
    const res = await workspaces.updateMany(
      { _id: { $in: old.map((w) => w._id) } },
      { $set: { 'settings.summaryModel': DEFAULT_SUMMARY_MODEL } },
    );
    console.log(`updated ${res.modifiedCount}`);
  } else if (!values.apply) {
    console.log('dry run: nothing changed (pass --apply)');
  }
  await mongoose.disconnect();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
