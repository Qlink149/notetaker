import { parseArgs } from 'node:util';
import {
  assignByOverlap,
  assignWordSpeakers,
  computeCoverage,
  joinMeeting,
  labelSpeakersByTime,
  turnsToLines,
  wordClockJoin,
  type DiarizationOutput,
  type TimedWord,
} from '@meetingid/pipeline';
import type { Turn } from '@meetingid/shared';
import { EngineResponseModel, MeetingDataModel } from '../../models/index.js';
import { P2JoinModel, P2PyannoteResponseModel } from '../../models/phase2.js';
import { PHASE1_SPEAKERS, connect, meetingIds, run, type TestMeeting } from './lib.js';

// Join Gemini's stored turns to pyannote speakers (precision-2) with M1, M3 and the per-chunk
// chooser, label speakers "Speaker A…" by speaking time, and store the lines in p2_join_lines.
// No engine calls. Prints coverage against Phase 1 and the M1/M3 agreement.
//   npm run p2:join -w @meetingid/api -- [all | names…] [--model precision-2]
run(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { model: { type: 'string', default: 'precision-2' } },
  });
  await connect();
  for (const m of meetingIds(positionals)) {
    const data = await MeetingDataModel.findOne({ meetingId: m.id }).lean();
    const pya = await P2PyannoteResponseModel.findOne({
      meetingId: m.id,
      kind: 'diarize',
      model: values.model,
      tag: 'stageA',
      status: 'succeeded',
    }).lean();
    if (!data || !pya) {
      console.log(`${m.name}: missing meeting data or pyannote output; skipped`);
      continue;
    }
    const out = pya.output as DiarizationOutput;
    const segments = out.exclusiveDiarization ?? out.diarization;
    const dgDoc = await EngineResponseModel.findOne({
      meetingId: m.id,
      engine: 'deepgram',
      kind: 'words',
      error: null,
    }).lean();
    const dgRaw = dgDoc?.response as
      | {
          results?: {
            channels?: {
              alternatives?: {
                words?: { word: string; punctuated_word?: string; start: number; end: number }[];
              }[];
            }[];
          };
        }
      | undefined;
    const dgWords: TimedWord[] = (
      dgRaw?.results?.channels?.[0]?.alternatives?.[0]?.words ?? []
    ).map((w) => ({ text: (w.punctuated_word ?? w.word).trim(), start: w.start, end: w.end }));
    const turns = (data.turns as Turn[]).map((t) => ({ ...t }));
    const speechSegments = data.speechSegments ?? [];
    const speakerMap = labelSpeakersByTime(segments);
    const lineOf = (ts: Turn[]) => turnsToLines(ts, speakerMap);
    const cov = (ts: Turn[]) => computeCoverage(speechSegments, ts).ratio;

    const joined = joinMeeting({
      turns,
      chunks: data.chunks.filter((c) => c.status === 'done'),
      segments,
      dgWords,
      speechSegments,
    });
    const m1 = assignByOverlap(turns, segments);
    const m3 = dgWords.length ? wordClockJoin(turns, assignWordSpeakers(dgWords, segments)) : null;

    const phase1Cov = cov(turns);
    interface Variant {
      method: 'm1' | 'm3' | 'joined';
      turns: Turn[];
      extra: Record<string, unknown>;
    }
    const variants: Variant[] = [{ method: 'm1', turns: m1.turns, extra: {} }];
    if (m3) variants.push({ method: 'm3', turns: m3.turns, extra: { ...m3.stats } });
    variants.push({
      method: 'joined',
      turns: joined.turns,
      extra: {
        decisions: joined.decisions,
        agreement: joined.agreement,
        m3Stats: joined.m3Stats,
      },
    });
    for (const { method, turns: ts, extra } of variants) {
      const lines = lineOf(ts);
      const coverage = cov(ts);
      const usable = coverage >= phase1Cov - 0.002;
      await P2JoinModel.updateOne(
        { meetingId: m.id, method },
        {
          $set: {
            turns: ts,
            lines,
            speakerMap,
            stats: {
              ...extra,
              model: values.model,
              coverage,
              phase1Coverage: phase1Cov,
              coverageOk: usable,
              speakers: new Set(lines.map((l) => l.speakerName)).size,
              lines: lines.length,
              maxLineSec: Math.max(0, ...lines.map((l) => l.end - l.start)),
            },
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
      console.log(
        `${m.name} ${method.padEnd(6)} speakers ${new Set(lines.map((l) => l.speakerName)).size} ` +
          `(Phase 1: ${PHASE1_SPEAKERS[m.name as TestMeeting] ?? '?'}), lines ${lines.length}, ` +
          `coverage ${coverage} vs ${phase1Cov}${usable ? '' : '  ** LOWER than Phase 1 **'}`,
      );
    }
    console.log(
      `${m.name} chunks: ${joined.decisions
        .map((d) => `${d.index}:${d.method}(${d.deepgramCoverage})`)
        .join(' ')}; M1/M3 agreement ${joined.agreement.overall ?? 'n/a'}` +
        (joined.m3Stats
          ? `; M3 matched ${joined.m3Stats.matched}/${joined.m3Stats.words} words`
          : ''),
    );
  }
});
