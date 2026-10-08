// Scoreboard for the stored joins (p2_join_lines), with no engine calls. Per meeting and method:
// Gemini words kept, pyannote speech with no text near it, Deepgram words that sit under a different
// speaker than pyannote heard, and Deepgram words found in the text at their time (an independent
// check of the times). Gemini's own clock is not trusted here: it is off by seconds to minutes.
//   npm run p2:joincheck -w @meetingid/api
import {
  assignWordSpeakers,
  labelSpeakersByTime,
  splitWords,
  unionIntervals,
  type DiarizationOutput,
  type TimedWord,
} from '@meetingid/pipeline';
import type { Turn } from '@meetingid/shared';
import { EngineResponseModel, MeetingDataModel } from '../../models/index.js';
import { P2JoinModel, P2PyannoteResponseModel } from '../../models/phase2.js';
import { connect, meetingIds, run } from './lib.js';
const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');
run(async () => {
  await connect();
  for (const m of meetingIds(['21-9', '200', 'AOM', 'Prachar'])) {
    const data: any = await MeetingDataModel.findOne({ meetingId: m.id }).lean();
    const pya: any = await P2PyannoteResponseModel.findOne({
      meetingId: m.id,
      kind: 'diarize',
      model: 'precision-2',
      tag: 'stageA',
      status: 'succeeded',
    }).lean();
    const out = pya.output as DiarizationOutput;
    const segs = out.exclusiveDiarization ?? out.diarization;
    const dgDoc: any = await EngineResponseModel.findOne({
      meetingId: m.id,
      engine: 'deepgram',
      kind: 'words',
      error: null,
    }).lean();
    const dgw: TimedWord[] = (
      dgDoc.response.results.channels[0].alternatives[0].words as any[]
    ).map((w) => ({ text: (w.punctuated_word ?? w.word).trim(), start: w.start, end: w.end }));
    const dg = assignWordSpeakers(dgw, segs);
    const gem: Turn[] = data.phase1?.turns ?? data.turns;
    const gemWords = gem.reduce((a, t) => a + splitWords(t.textNative).length, 0);
    const speakerMap = labelSpeakersByTime(segs);
    const pv = unionIntervals(segs.map((x: any) => ({ start: x.start, end: x.end })));
    const pvTot = pv.reduce((a, x) => a + x.end - x.start, 0);
    console.log(`\n== ${m.name}  (Gemini words ${gemWords}; pyannote speech ${pvTot.toFixed(0)}s)`);
    for (const method of ['m1', 'm3', 'joined'] as const) {
      const j: any = await P2JoinModel.findOne({ meetingId: m.id, method }).lean();
      const turns = j.turns as Turn[];
      const words = turns.reduce((a, t) => a + splitWords(t.textNative).length, 0);
      // order: Gemini's turns are in speaking order; pieces are sorted by time, so compare consecutive output starts to their text order via source: approximate with start monotonic of first words
      // speech without text (pyannote speech not within +-1s of any turn)
      const cov = unionIntervals(
        turns.map((t) => ({ start: t.start - 1, end: Math.max(t.end, t.start) + 1 })),
      );
      let un = 0;
      for (const s of pv) {
        let cur = s.start;
        for (const c of cov) {
          if (c.end <= cur) continue;
          if (c.start >= s.end) break;
          if (c.start > cur) un += Math.min(c.start, s.end) - cur;
          cur = Math.max(cur, c.end);
        }
        if (cur < s.end) un += s.end - cur;
      }
      // words vs pyannote at DG words
      const lines = turns.slice().sort((a, b) => a.start - b.start);
      let bad = 0,
        n = 0,
        badSec = 0,
        totSec = 0;
      for (const w of dg) {
        const mid = (w.start + w.end) / 2;
        const t = lines.find((x) => mid >= x.start && mid <= x.end);
        const d = Math.max(0.05, w.end - w.start);
        n++;
        totSec += d;
        if (t && w.speaker && t.speaker !== w.speaker) {
          bad++;
          badSec += d;
        }
      }
      // are Deepgram words inside a turn whose text contains that word (loosely)? check lexical consistency: share of DG words whose time falls inside a turn that contains a similar token
      const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      let lex = 0,
        lexN = 0;
      for (const w of dg) {
        const k = norm(w.text);
        if (k.length < 3) continue;
        const mid = (w.start + w.end) / 2;
        const t = lines.filter((x) => mid >= x.start - 1 && mid <= x.end + 1);
        lexN++;
        if (t.some((x) => norm(x.textNative).includes(k))) lex++;
      }
      console.log(
        `${method.padEnd(7)} words kept ${pct(words, gemWords)} | pyannote speech with no text ${un.toFixed(0)}s (${pct(un, pvTot)}) | Deepgram words under a different speaker than pyannote ${pct(bad, n)} (${pct(badSec, totSec)} of time) | Deepgram words found in the text at their time ${pct(lex, lexN)}`,
      );
    }
  }
});
