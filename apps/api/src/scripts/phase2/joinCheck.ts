import {
  assignWordSpeakers,
  splitWords,
  unionIntervals,
  type DiarizationOutput,
  type TimedWord,
} from '@meetingid/pipeline';
import type { Turn } from '@meetingid/shared';
import { EngineResponseModel, MeetingDataModel } from '../../models/index.js';
import { P2JoinModel, P2PyannoteResponseModel } from '../../models/phase2.js';
import { connect, meetingIds, run } from './lib.js';

// Scoreboard for the stored joins (p2_join_lines), with no engine calls. Per meeting and method:
// Gemini words kept, pyannote speech with no text near it, Deepgram words that sit under a different
// speaker than pyannote heard, and Deepgram words found in the text at their time (an independent
// check of the times). Gemini's own clock is not trusted here: it is off by seconds to minutes.
//   npm run p2:joincheck -w @meetingid/api
const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

interface RawWords {
  results: {
    channels: {
      alternatives: {
        words: { word: string; punctuated_word?: string; start: number; end: number }[];
      }[];
    }[];
  };
}

run(async () => {
  await connect();
  for (const m of meetingIds(['21-9', '200', 'AOM', 'Prachar'])) {
    const data = await MeetingDataModel.findOne({ meetingId: m.id }).lean();
    const pya = await P2PyannoteResponseModel.findOne({
      meetingId: m.id,
      kind: 'diarize',
      model: 'precision-2',
      tag: 'stageA',
      status: 'succeeded',
    }).lean();
    const dgDoc = await EngineResponseModel.findOne({
      meetingId: m.id,
      engine: 'deepgram',
      kind: 'words',
      error: null,
    }).lean();
    if (!data || !pya || !dgDoc) continue;
    const out = pya.output as DiarizationOutput;
    const segs = out.exclusiveDiarization ?? out.diarization;
    const raw = (dgDoc.response as RawWords).results.channels[0]!.alternatives[0]!.words;
    const dg: TimedWord[] = assignWordSpeakers(
      raw.map((w) => ({ text: (w.punctuated_word ?? w.word).trim(), start: w.start, end: w.end })),
      segs,
    );
    const gem = (data.phase1?.turns ?? data.turns) as Turn[];
    const gemWords = gem.reduce((a, t) => a + splitWords(t.textNative).length, 0);
    const speech = unionIntervals(segs.map((x) => ({ start: x.start, end: x.end })));
    const speechSec = speech.reduce((a, x) => a + x.end - x.start, 0);
    console.log(
      `\n== ${m.name}  (Gemini words ${gemWords}; pyannote speech ${speechSec.toFixed(0)}s)`,
    );
    for (const method of ['m1', 'm3', 'joined'] as const) {
      const join = await P2JoinModel.findOne({ meetingId: m.id, method }).lean();
      if (!join) continue;
      const turns = (join.turns as Turn[]).slice().sort((a, b) => a.start - b.start);
      const words = turns.reduce((a, t) => a + splitWords(t.textNative).length, 0);
      // pyannote speech with no turn within 1 s
      const covered = unionIntervals(
        turns.map((t) => ({ start: t.start - 1, end: Math.max(t.end, t.start) + 1 })),
      );
      let bare = 0;
      for (const s of speech) {
        let cur = s.start;
        for (const c of covered) {
          if (c.end <= cur) continue;
          if (c.start >= s.end) break;
          if (c.start > cur) bare += Math.min(c.start, s.end) - cur;
          cur = Math.max(cur, c.end);
        }
        if (cur < s.end) bare += s.end - cur;
      }
      // Deepgram words under another speaker than pyannote heard, and found in the text at their time
      let wrong = 0;
      let wrongSec = 0;
      let totalSec = 0;
      let found = 0;
      let foundOf = 0;
      for (const w of dg) {
        const mid = (w.start + w.end) / 2;
        const dur = Math.max(0.05, w.end - w.start);
        totalSec += dur;
        const at = turns.find((x) => mid >= x.start && mid <= x.end);
        if (at && w.speaker && at.speaker !== w.speaker) {
          wrong++;
          wrongSec += dur;
        }
        const key = norm(w.text);
        if (key.length < 3) continue;
        foundOf++;
        const near = turns.filter((x) => mid >= x.start - 1 && mid <= x.end + 1);
        if (near.some((x) => norm(x.textNative).includes(key))) found++;
      }
      console.log(
        `${method.padEnd(7)} words kept ${pct(words, gemWords)} | pyannote speech with no text ${bare.toFixed(0)}s (${pct(bare, speechSec)}) | ` +
          `Deepgram words under a different speaker than pyannote ${pct(wrong, dg.length)} (${pct(wrongSec, totalSec)} of time) | ` +
          `Deepgram words found in the text at their time ${pct(found, foundOf)}`,
      );
    }
  }
});
