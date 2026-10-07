import { parseArgs } from 'node:util';
import { Types } from 'mongoose';
import { deepgramWordClock } from '../../services/engines/deepgram.js';
import { EngineResponseModel } from '../../models/index.js';
import { analysisFlac, connect, meetingIds, run } from './lib.js';

// Deepgram word timestamps for whole meetings (the M3 word clock). One request per meeting; the raw
// reply is stored in engineresponses (engine "deepgram", kind "words"). A stored reply is reused.
// Budget tonight: at most 6 Deepgram jobs.
//   npm run p2:deepgram -w @meetingid/api -- <21-9 | 200 | AOM | Prachar | id>… [--max 4]
const LANGUAGE: Record<string, 'hi' | 'gu'> = { '200': 'gu' };

run(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { max: { type: 'string', default: '4' } },
  });
  await connect();
  let spent = 0;
  for (const m of meetingIds(positionals)) {
    const have = await EngineResponseModel.findOne({
      meetingId: m.id,
      engine: 'deepgram',
      kind: 'words',
      error: null,
    }).lean();
    if (have) {
      console.log(`${m.name}: stored reply ${have._id} reused`);
      continue;
    }
    if (spent >= Number(values.max)) throw new Error(`Deepgram job budget (${values.max}) reached`);
    const language = LANGUAGE[m.name] ?? 'hi';
    const flac = await analysisFlac(m.id);
    console.log(`${m.name}: Deepgram nova-3 language=${language}`);
    const r = await deepgramWordClock(flac, 'audio/flac', language);
    spent++;
    await EngineResponseModel.create({
      meetingId: new Types.ObjectId(m.id),
      kind: 'words',
      chunkIndex: null,
      startSec: 0,
      endSec: r.durationSec,
      engine: 'deepgram',
      model: `nova-3/${language}`,
      promptVersion: 'deepgram-words-v1',
      promptHash: '',
      prompt: '',
      userText: '',
      status: 'ok',
      text: null,
      response: r.raw,
      usage: { inputTokens: 0, outputTokens: 0, audioSec: r.durationSec },
      keyLabel: 'DEEPGRAM_API_KEY',
      error: null,
      receivedAt: new Date(),
    });
    console.log(`${m.name}: ${r.words.length} words over ${Math.round(r.durationSec)} s`);
  }
  console.log(`Deepgram jobs spent: ${spent}`);
});
