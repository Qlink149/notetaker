import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { requireEnv } from '../config/env.js';
import { WorkspaceModel } from '../models/index.js';
import { EditError, restoreIdentity } from '../services/identity/edits.js';

// Repair a speaker correction that rewrote a shared profile: it renamed that person in every meeting,
// or merged them into someone else, so earlier meetings and tasks followed. Pass the profile that
// currently holds those meetings, the meeting ids to give back, and the name they should have.
// Prints the plan and writes nothing unless --apply. It is not run by the app.
//
//   npm run restore:identity -w @meetingid/api -- \
//     --workspace <id-or-slug> --from <personId> --name "Speaker X" \
//     --meetings <id>,<id> [--move-tasks] [--adopt-orphan-tasks] [--apply]
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'uri-env': { type: 'string', default: 'MONGODB_URI' },
      db: { type: 'string', default: '' },
      workspace: { type: 'string' },
      from: { type: 'string' },
      name: { type: 'string' },
      meetings: { type: 'string' },
      'move-tasks': { type: 'boolean' },
      'adopt-orphan-tasks': { type: 'boolean' },
      apply: { type: 'boolean' },
    },
  });
  if (!values.workspace || !values.from || !values.name || !values.meetings) {
    console.error(
      'Required: --workspace <id-or-slug> --from <personId> --name <restored name> --meetings <id>,<id>',
    );
    process.exit(1);
  }
  const uri = process.env[values['uri-env']!] ?? requireEnv('MONGODB_URI');
  await mongoose.connect(uri, values.db ? { dbName: values.db } : {});
  try {
    const byId = mongoose.Types.ObjectId.isValid(values.workspace)
      ? await WorkspaceModel.findById(values.workspace).lean()
      : null;
    const ws = byId ?? (await WorkspaceModel.findOne({ slug: values.workspace }).lean());
    if (!ws) throw new EditError(`Workspace "${values.workspace}" was not found.`);
    const plan = await restoreIdentity(
      String(ws._id),
      {
        fromPersonId: values.from,
        name: values.name,
        meetingIds: values.meetings.split(','),
        moveTasks: values['move-tasks'] === true,
        adoptOrphanTasks: values['adopt-orphan-tasks'] === true,
      },
      { apply: values.apply === true },
    );
    console.log(JSON.stringify(plan, null, 2));
    if (!values.apply) console.log('dry run: nothing changed (pass --apply)');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EditError) console.error(err.message);
  else console.error(err);
  process.exit(1);
});
