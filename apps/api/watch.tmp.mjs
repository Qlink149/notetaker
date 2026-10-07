import mongoose from 'mongoose';
await mongoose.connect(process.env.MONGODB_URI, { dbName: 'meetingid' });
const db = mongoose.connection.db;
const id = new mongoose.Types.ObjectId(process.argv[2]);
const t0 = Date.now();
let last = '';
while (Date.now() - t0 < 9 * 60_000) {
  const m = await db.collection('meetings').findOne({ _id: id });
  const jobs = await db.collection('jobs').find({ meetingId: id }).toArray();
  const s =
    `${m.status}/${m.stage} ${JSON.stringify(m.progress)} | ` +
    jobs
      .map(
        (j) =>
          `${j.stage}${j.step ?? ''}:${j.status}#${j.attempts}${j.lastError ? ' err=' + j.lastError.slice(0, 50) : ''}`,
      )
      .join(' ');
  if (s !== last) {
    console.log(new Date().toISOString().slice(11, 19), s);
    last = s;
  }
  if (m.stage === 'done' || m.status === 'failed') break;
  await new Promise((r) => setTimeout(r, 10000));
}
await mongoose.disconnect();
