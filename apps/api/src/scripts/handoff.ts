import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { env } from '../config/env.js';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { HandoffModel } from '../models/index.js';

// Summary handoff for testing (SUMMARY_PROVIDER=handoff):
//   npm run handoff -w @meetingid/api -- pending            writes scratch/handoff/<id>.prompt.txt for each open request
//   npm run handoff -w @meetingid/api -- submit <id> <file>  stores the agent's raw reply for that request

const dir = resolve(import.meta.dirname, '../../../../scratch/handoff');
const safe = (id: string) => id.replace(/[^a-z0-9]+/gi, '_');

async function main(): Promise<void> {
  const [cmd, id, file] = process.argv.slice(2);
  const cfg = env();
  await connectMongo(cfg.MONGODB_URI, cfg.MONGODB_DB);
  if (cmd === 'pending') {
    await mkdir(dir, { recursive: true });
    const open = await HandoffModel.find({ status: 'pending' }).lean();
    for (const h of open) {
      const path = join(dir, `${safe(h._id)}.prompt.txt`);
      await writeFile(path, `=== SYSTEM ===\n${h.system}\n\n=== USER ===\n${h.user}\n`);
      console.log(
        `${h._id}\t${h.model}\t${h.user.length} chars\trejections=${h.rejections}\t${h.lastError ?? ''}\t${path}`,
      );
    }
    if (!open.length) console.log('no pending handoff requests');
  } else if (cmd === 'submit' && id && file) {
    const response = await readFile(file, 'utf8');
    const r = await HandoffModel.updateOne(
      { _id: id, status: 'pending' },
      { $set: { status: 'answered', response, answeredAt: new Date() } },
    );
    console.log(
      r.modifiedCount ? `submitted ${response.length} chars for ${id}` : `no pending request ${id}`,
    );
  } else {
    console.log('usage: handoff pending | handoff submit <id> <file>');
  }
  await disconnectMongo();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await disconnectMongo().catch(() => undefined);
  process.exit(1);
});
