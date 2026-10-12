import { calculateObjectSize } from 'bson';
import { parseArgs } from 'node:util';
import { P2PyannoteResponseModel } from '../../models/phase2.js';
import { trimOutput } from '../../services/pyannote/output.js';
import { connect, run } from './lib.js';

// Remove the frame-by-frame `confidence` curve from pyannote replies stored before it was dropped.
// Nothing reads it; it is about half of what a meeting takes in MongoDB. Dry run unless --apply.
//   npm run p2:trim-responses -w @meetingid/api [-- --apply]
run(async () => {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' } } });
  await connect();
  let docs = 0;
  let saved = 0;
  for await (const d of P2PyannoteResponseModel.find({
    'output.confidence': { $exists: true },
  }).cursor()) {
    const before = calculateObjectSize(d.output as object);
    const after = calculateObjectSize(trimOutput(d.output) as object);
    docs++;
    saved += before - after;
    if (values.apply)
      await P2PyannoteResponseModel.updateOne(
        { _id: d._id },
        { $set: { output: trimOutput(d.output) } },
      );
  }
  console.log(
    `${values.apply ? 'trimmed' : 'would trim'} ${docs} replies, ${(saved / 1048576).toFixed(1)} MB ${values.apply ? 'freed' : 'to free'}`,
  );
});
