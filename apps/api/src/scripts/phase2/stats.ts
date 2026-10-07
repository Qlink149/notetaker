import { parseArgs } from 'node:util';
import { diarizationStats, sampleSegments, type DiarizationOutput } from '@meetingid/pipeline';
import { MeetingDataModel, MeetingModel } from '../../models/index.js';
import { P2PyannoteResponseModel } from '../../models/phase2.js';
import { PHASE1_SPEAKERS, connect, meetingIds, run, type TestMeeting } from './lib.js';

// Stage A3: per meeting × model statistics of stored pyannote diarizations, next to Phase 1's
// Gemini speaker counts. Reads only stored output (no API calls).
//   npm run p2:stats -w @meetingid/api -- [all | names…] [--tag stageA] [--markdown]
run(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { tag: { type: 'string', default: 'stageA' }, markdown: { type: 'boolean' } },
  });
  await connect();
  const rows: string[] = [];
  const samples: string[] = [];
  for (const m of meetingIds(positionals)) {
    const meeting = await MeetingModel.findById(m.id).lean();
    const data = await MeetingDataModel.findOne({ meetingId: m.id }, { lines: 1 }).lean();
    const geminiNow = data ? new Set(data.lines.map((l) => l.speakerName)).size : null;
    const docs = await P2PyannoteResponseModel.find({
      meetingId: m.id,
      kind: 'diarize',
      tag: values.tag,
      status: 'succeeded',
    })
      .sort({ model: 1 })
      .lean();
    for (const doc of docs) {
      const out = doc.output as DiarizationOutput;
      const s = diarizationStats(out.diarization);
      const ex = out.exclusiveDiarization ? diarizationStats(out.exclusiveDiarization) : null;
      const p1 =
        m.name in PHASE1_SPEAKERS
          ? (PHASE1_SPEAKERS[m.name as TestMeeting] ?? 'pending')
          : geminiNow;
      rows.push(
        `| ${m.name} | ${doc.model} | ${s.speakers} | ${p1 ?? '–'} | ${s.speechSec} | ` +
          `${(s.overlapShare * 100).toFixed(1)}% | ${s.segments} | ${ex?.segments ?? '–'} | ` +
          `${s.medianSegSec} | ${s.p90SegSec} | ${s.lowConfidenceShare === null ? '–' : `${(s.lowConfidenceShare * 100).toFixed(1)}%`} |`,
      );
      samples.push(
        `#### ${m.name} (${meeting?.title}) — ${doc.model}`,
        `Speaker time: ${s.perSpeaker.map((p) => `${p.speaker} ${p.sec}s`).join(', ')}`,
        out.warning ? `Warning: ${out.warning}` : '',
        '```',
        ...sampleSegments(out.exclusiveDiarization ?? out.diarization),
        '```',
      );
    }
    if (!docs.length) rows.push(`| ${m.name} | (no stored diarization for tag ${values.tag}) |`);
  }
  console.log(
    [
      '| Meeting | Model | pyannote speakers | Phase 1 Gemini speakers | Speech s | Overlap | Segments | Exclusive segs | Median seg s | P90 seg s | Speech with turn conf < 60 |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
      ...rows,
      '',
      ...samples.filter((l) => l !== ''),
    ].join('\n'),
  );
});
