import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pickWordClock } from '@meetingid/pipeline';
import { EngineResponseModel, MeetingDataModel } from '../src/models/index.js';
import { P2PyannoteResponseModel } from '../src/models/phase2.js';
import { loadJoinInput } from '../src/services/identity/joinInput.js';
import { clearDb, startDb, stopDb } from './helpers.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

// Deepgram's reply shape, with one word per second (dense) or every 20 s (sparse) in [from, to).
const reply = (from: number, to: number, step: number) => ({
  results: {
    channels: [
      {
        alternatives: [
          {
            words: Array.from({ length: Math.floor((to - from) / step) }, (_, i) => ({
              word: `w${from + i * step}`,
              start: from + i * step,
              end: from + i * step + 0.8,
            })),
          },
        ],
      },
    ],
  },
});

async function words(meetingId: Types.ObjectId, model: string, response: unknown, at: number) {
  await EngineResponseModel.create({
    meetingId,
    kind: 'words',
    chunkIndex: null,
    startSec: 0,
    endSec: 200,
    engine: 'deepgram',
    model,
    response,
    error: null,
    receivedAt: new Date(at),
  });
}

describe('word clocks of a meeting in two languages', () => {
  it('loads Hindi and Gujarati, and the join takes Gujarati where it heard more', async () => {
    const id = new Types.ObjectId();
    await MeetingDataModel.create({
      meetingId: id,
      speakerSource: 'pyannote',
      speechSegments: [{ start: 0, end: 200 }],
    });
    await P2PyannoteResponseModel.create({
      meetingId: id,
      kind: 'diarize',
      model: 'precision-2',
      tag: 'pipeline',
      status: 'succeeded',
      jobId: 'j',
      keyLabel: 'PYANNOTEAI_API_KEY',
      submittedAt: new Date(),
      output: { diarization: [{ speaker: 'S0', start: 0, end: 200 }] },
    });
    // a mostly Gujarati meeting: the Hindi clock is sparse, the Gujarati one dense
    await words(id, 'nova-3/hi', reply(0, 200, 20), 1);
    await words(id, 'nova-3/gu', reply(0, 200, 1), 2);

    const join = await loadJoinInput(String(id));
    expect(join!.dgSources.map((s) => s.label)).toEqual(['hi', 'gu']);
    expect(join!.dgWords).toHaveLength(10); // the first (Hindi) clock, as before
    const picked = pickWordClock(
      join!.dgSources,
      [
        { index: 0, startSec: 0, endSec: 100 },
        { index: 1, startSec: 90, endSec: 200 },
      ],
      [{ start: 0, end: 200 }],
    );
    expect(picked.picks.map((p) => p.label)).toEqual(['gu', 'gu']);
    expect(picked.words.length).toBeGreaterThan(150);
  });
});
