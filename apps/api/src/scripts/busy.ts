import { env } from '../config/env.js';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { activeWork } from '../pipeline/queue.js';

// Is the worker processing a meeting? The deploy runs this before replacing the worker, so a new version never
// cuts a meeting short (exit 0 = idle, 3 = busy).
//   node apps/api/dist/scripts/busy.js
async function main(): Promise<number> {
  const cfg = env();
  await connectMongo(cfg.MONGODB_URI, cfg.MONGODB_DB);
  const work = await activeWork();
  console.log(JSON.stringify(work));
  await disconnectMongo();
  return work.running + work.due > 0 ? 3 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    // unknown is not idle: the deploy waits rather than guess
    process.exit(3);
  });
