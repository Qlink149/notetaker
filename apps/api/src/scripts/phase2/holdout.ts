import {
  assignByOverlap,
  assignWordSpeakers,
  splitWords,
  turnTrust,
  wordClockJoin,
  type DiarizationOutput,
  type TimedWord,
} from '@meetingid/pipeline';
import type { Turn } from '@meetingid/shared';
import { EngineResponseModel, MeetingDataModel } from '../../models/index.js';
import { P2PyannoteResponseModel } from '../../models/phase2.js';
import { connect, meetingIds, run } from './lib.js';

// Held-out test of the speaker join, with no engine calls. Deepgram's words give every Gemini word
// they match a time and a speaker that do not depend on Gemini's clock. Hide every third block of
// Deepgram words (10 s and 60 s blocks), join again, and ask how often each method gives the hidden
// words the speaker the full run knew, and how far off their times are.
//   npm run p2:holdout -w @meetingid/api
const median = (v: number[]): number =>
  [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? NaN;
const p90 = (v: number[]): number =>
  [...v].sort((a, b) => a - b)[Math.floor(v.length * 0.9)] ?? NaN;

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
  for (const block of [10, 60]) {
    console.log(
      `\nhiding every third ${block} s block of Deepgram words (columns: 21-9, 200, AOM, Prachar)`,
    );
    const rows: Record<string, number[]> = {};
    const times: Record<string, string[]> = {};
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
        raw.map((w) => ({
          text: (w.punctuated_word ?? w.word).trim(),
          start: w.start,
          end: w.end,
        })),
        segs,
      );
      const held = dg.filter((w) => Math.floor(w.start / block) % 3 !== 0);
      // Phase 1's turns: after an install, data.turns already holds a join's output
      const turns = (data.phase1?.turns ?? data.turns) as Turn[];
      const full = wordClockJoin(turns, dg, { segments: segs });
      const h = wordClockJoin(turns, held, { segments: segs });
      const trust = turnTrust(turns, h.tokens);
      const turnOf: number[] = [];
      const pace: number[] = [];
      turns.forEach((t, ti) => {
        const n = splitWords(t.textNative).length;
        for (let k = 0; k < n; k++) {
          turnOf.push(ti);
          pace.push(t.start + ((k + 0.5) / n) * (t.end - t.start));
        }
      });
      const shifted = turns.map((t, i) =>
        trust.shiftKnown[i]
          ? { ...t, start: t.start + trust.shift[i]!, end: t.end + trust.shift[i]! }
          : t,
      );
      const clock = h.tokenSpeakers.flat();
      const m1Raw = assignByOverlap(turns, segs).tokenSpeakers.flat();
      const m1Shift = assignByOverlap(shifted, segs).tokenSpeakers.flat();
      const methods: Record<string, (i: number) => string | undefined> = {
        'word clock only': (i) => clock[i],
        'M1 on Gemini times as they are': (i) => m1Raw[i],
        'final: word clock, M1 shifted by drift where poorly anchored': (i) =>
          trust.poor[turnOf[i]!] ? m1Shift[i] : clock[i],
      };
      for (const [name, pick] of Object.entries(methods)) {
        let lost = 0;
        let ok = 0;
        full.tokens.forEach((t, i) => {
          if (!t.matched || h.tokens[i]!.matched) return;
          lost++;
          if (pick(i) === t.speaker) ok++;
        });
        (rows[name] ??= []).push((100 * ok) / lost);
      }
      const err: Record<string, number[]> = {
        'word clock': [],
        'Gemini as it is': [],
        'Gemini + measured drift': [],
      };
      full.tokens.forEach((t, i) => {
        if (!t.matched || h.tokens[i]!.matched) return;
        err['word clock']!.push(Math.abs(h.tokens[i]!.start - t.start));
        err['Gemini as it is']!.push(Math.abs(pace[i]! - t.start));
        err['Gemini + measured drift']!.push(
          Math.abs(pace[i]! + trust.shift[turnOf[i]!]! - t.start),
        );
      });
      for (const [k, v] of Object.entries(err))
        (times[k] ??= []).push(`${median(v).toFixed(1)}/${p90(v).toFixed(1)}`);
    }
    console.log('speaker right on hidden words (%):');
    for (const [k, v] of Object.entries(rows))
      console.log(
        `  ${k.padEnd(62)} ${v.map((x) => x.toFixed(1).padStart(5)).join(' ')}   mean ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)}`,
      );
    console.log('time error, median/p90 seconds:');
    for (const [k, v] of Object.entries(times)) console.log(`  ${k.padEnd(62)} ${v.join('  ')}`);
  }
});
