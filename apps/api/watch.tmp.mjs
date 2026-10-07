// node --env-file=.env watch.mjs <meetingId> <untilChunksDone|final> [timeoutMin]
import mongoose from 'mongoose';
const [id, until, tmin = '28'] = process.argv.slice(2);
await mongoose.connect(process.env.MONGODB_URI, { dbName: 'meetingid' });
const db = mongoose.connection.db;
const oid = new mongoose.Types.ObjectId(id);
const t0 = Date.now();
let last = '';
for (;;) {
  const m = await db.collection('meetings').findOne({ _id: oid });
  const d = await db.collection('meetingdata').findOne({ meetingId: oid }, { projection: { 'chunks.index': 1, 'chunks.status': 1, 'chunks.model': 1 } });
  const ch = (d?.chunks ?? []).map((c) => `${c.index}:${c.status}${c.model ? '@' + c.model.replace('gemini-', '') : ''}`).join(' ');
  const s = `${m.status}/${m.stage} ${m.progress.chunksDone}/${m.progress.chunksTotal} [${ch}] summary=${m.summaryStatus}${m.error ? ' ERR ' + m.error.message.slice(0, 80) : ''}`;
  if (s !== last) { console.log(new Date().toISOString().slice(11, 19), s); last = s; }
  if (m.stage === 'done' || m.status === 'failed') { console.log('TERMINAL'); break; }
  if (until !== 'final' && m.progress.chunksDone >= Number(until)) { console.log('REACHED', until); break; }
  if (Date.now() - t0 > Number(tmin) * 60_000) { console.log('TIMEOUT'); break; }
  await new Promise((r) => setTimeout(r, 5000));
}
await mongoose.disconnect();
