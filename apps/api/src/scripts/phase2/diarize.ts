import { parseArgs } from 'node:util';
import {
  PYANNOTE_MODELS,
  diarizeBody,
  submitDiarize,
  type PyannoteModel,
} from '../../services/pyannote/client.js';
import { connect, meetingIds, meetingMedia, run, runJob } from './lib.js';

// Stage A2: diarize test meetings with pyannote and store the complete output in
// p2_pyannote_responses. No Gemini calls. Resumable: a stored result is reused, a running job resumed.
//   npm run p2:diarize -w @meetingid/api -- [all | 21-9 200 AOM Prachar | <meetingId>…]
//     [--model precision-2,precision-3] [--tag stageA] [--min N] [--max N] [--num N]
run(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: 'string', default: PYANNOTE_MODELS.join(',') },
      tag: { type: 'string', default: 'stageA' },
      min: { type: 'string' },
      max: { type: 'string' },
      num: { type: 'string' },
    },
  });
  const models = values.model.split(',').map((m) => {
    if (!PYANNOTE_MODELS.includes(m as PyannoteModel)) throw new Error(`unknown model ${m}`);
    return m as PyannoteModel;
  });
  const counts = {
    minSpeakers: values.min ? Number(values.min) : undefined,
    maxSpeakers: values.max ? Number(values.max) : undefined,
    numSpeakers: values.num ? Number(values.num) : undefined,
  };
  await connect();
  const meetings = meetingIds(positionals);
  console.log(`pyannote jobs to run: up to ${meetings.length * models.length}; Gemini calls: 0`);

  const jobs = [];
  for (const m of meetings) {
    const url = await meetingMedia(m.id);
    for (const model of models) {
      const body = diarizeBody(url, { model, ...counts });
      jobs.push(
        runJob({
          meetingId: m.id,
          kind: 'diarize',
          model,
          tag: values.tag,
          body,
          submit: () => submitDiarize(url, { model, ...counts }),
        }).then(
          (doc) => console.log(`done ${m.name} ${model}: ${doc.jobId}`),
          (err: unknown) => console.error(`FAILED ${m.name} ${model}: ${(err as Error).message}`),
        ),
      );
    }
  }
  await Promise.all(jobs);
});
