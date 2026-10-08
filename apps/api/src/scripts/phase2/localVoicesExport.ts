import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  labelSpeakersByTime,
  overlapRanges,
  type DiarizationOutput,
  type DiarSegment,
} from '@meetingid/pipeline';
import { MeetingDataModel, SpeakerModel } from '../../models/index.js';
import { P2PyannoteResponseModel } from '../../models/phase2.js';
import { connect, meetingIds, run } from './lib.js';

// Write what the local voice check needs (no engine calls): per meeting and pyannote voice, the
// cleanest single-speaker stretches (no overlapped speech), plus pyannote's current person links.
// Audio is the cached analysis FLAC under scratch/p2/<meetingId>/.
//   npm run p2:localvoices-export -w @meetingid/api  ->  tools/local-voices/out/segments.json
const root = resolve(import.meta.dirname, '../../../../..');
const MIN_SEC = 1.5;
const PER_VOICE = 24;

run(async () => {
  await connect();
  const meetings: Record<string, unknown> = {};
  for (const m of meetingIds(['21-9', '200', 'AOM', 'Prachar'])) {
    const pya = await P2PyannoteResponseModel.findOne({
      meetingId: m.id,
      kind: 'diarize',
      model: 'precision-2',
      tag: 'stageA',
      status: 'succeeded',
    }).lean();
    const data = await MeetingDataModel.findOne({ meetingId: m.id }).lean();
    if (!pya || !data) continue;
    const out = pya.output as DiarizationOutput;
    const exclusive: DiarSegment[] = out.exclusiveDiarization ?? out.diarization;
    const overlaps = overlapRanges(out.diarization ?? exclusive);
    const labels = labelSpeakersByTime(exclusive);
    const people = new Map(
      (await SpeakerModel.find({}, { name: 1 }).lean()).map((p) => [String(p._id), p.name]),
    );
    const cards = new Map((data.speakerCards ?? []).map((c) => [c.diar, c]));
    const voices: Record<string, unknown> = {};
    const bySpeaker = new Map<string, DiarSegment[]>();
    for (const s of exclusive) bySpeaker.set(s.speaker, [...(bySpeaker.get(s.speaker) ?? []), s]);
    for (const [diar, segs] of bySpeaker) {
      const clean = segs
        .filter(
          (s) =>
            s.end - s.start >= MIN_SEC && !overlaps.some((o) => o.start < s.end && o.end > s.start),
        )
        .sort((a, b) => b.end - b.start - (a.end - a.start))
        .slice(0, PER_VOICE)
        .map((s) => ({ start: s.start, end: Math.min(s.end, s.start + 12) }));
      const card = cards.get(diar);
      voices[diar] = {
        label: labels[diar] ?? diar,
        sec: Math.round(segs.reduce((a, s) => a + s.end - s.start, 0)),
        personId: card?.personId ?? null,
        person: card?.personId ? (people.get(card.personId) ?? null) : null,
        status: card?.status ?? null,
        segments: clean,
      };
    }
    meetings[m.name] = { flac: resolve(root, 'scratch/p2', m.id, 'analysis.flac'), voices };
  }
  const dir = resolve(root, 'tools/local-voices/out');
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'segments.json'), JSON.stringify({ meetings }, null, 1));
  for (const [name, v] of Object.entries(
    meetings as Record<
      string,
      { voices: Record<string, { label: string; sec: number; segments: unknown[] }> }
    >,
  ))
    console.log(
      `${name}: ${Object.values(v.voices)
        .map((x) => `${x.label} ${x.sec}s/${x.segments.length} clips`)
        .join(', ')}`,
    );
});
