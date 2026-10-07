import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { geminiKeyEntries } from '../../config/env.js';
import { legacyKeyId } from '../../services/engines/geminiKeys.js';
import { connect, run } from './lib.js';

// Replace the key-derived ids Phase 1 stored (first 12 hex chars of sha256(key)) with labels (the env
// variable name): `geminiquotas._id` and `meetingdata.chunks[].geminiKeyId`. Dry run unless --apply.
// Only the connected database (MONGODB_DB) is touched; key values are never printed or stored.
//   npm run p2:migrate-key-labels -w @meetingid/api -- [--apply]
run(async () => {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' } } });
  await connect();
  const db = mongoose.connection.db!;
  const toLabel = new Map(geminiKeyEntries().map((e) => [legacyKeyId(e.value), e.name]));
  console.log(
    `database ${db.databaseName}; ${toLabel.size} configured keys; ${values.apply ? 'APPLYING' : 'dry run'}`,
  );

  // quota records: _id "<hash>:<model>" -> "<label>:<model>"
  const quotas = db.collection<{ _id: string; keyLabel?: string }>('geminiquotas');
  let quotaMoved = 0;
  for (const q of await quotas.find({}).toArray()) {
    const [id, ...model] = String(q._id).split(':');
    const label = toLabel.get(id ?? '');
    if (!label) continue;
    quotaMoved++;
    if (values.apply) {
      const { _id, ...rest } = q;
      void _id;
      await quotas.replaceOne(
        { _id: `${label}:${model.join(':')}` },
        { ...rest, keyLabel: label },
        { upsert: true },
      );
      await quotas.deleteOne({ _id: q._id });
    }
  }

  // chunks: geminiKeyId hash -> label
  const data = db.collection('meetingdata');
  let chunksUpdated = 0;
  for (const [hash, label] of toLabel) {
    const filter = { 'chunks.geminiKeyId': hash };
    const n = await data.countDocuments(filter);
    chunksUpdated += n;
    if (values.apply && n)
      await data.updateMany(
        filter,
        { $set: { 'chunks.$[c].geminiKeyId': label } },
        { arrayFilters: [{ 'c.geminiKeyId': hash }] },
      );
  }
  const left = await data.countDocuments({ 'chunks.geminiKeyId': { $regex: '^[0-9a-f]{12}$' } });
  console.log(
    `quota records to move: ${quotaMoved}; meetings with chunk key ids to rewrite: ${chunksUpdated}; hash-looking ids left: ${left}`,
  );
});
