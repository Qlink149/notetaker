import { Types } from 'mongoose';
import { env } from '../config/env.js';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { meetingView } from '../lib/views.js';
import { JobModel, MeetingDataModel, MeetingModel, type MeetingDoc } from '../models/index.js';
import { SEED_GLOSSARY } from './seed.js';

// Phase 1 acceptance metrics for processed meetings (read-only):
//   npm run acceptance -w @meetingid/api -- <meetingId> [...]
// Prints one JSON object per meeting with the §3 table fields and the evidence for items 2–4 and 6.

const SHORT =
  /^(haan|haa|ha|ji|haan ji|ji haan|hmm+|hm+|ok(ay)?|achha|accha|theek hai|yes( sir)?|no|nahi|right|sahi)[.!?]*$/i;
// Likely misspellings of glossary terms (case-insensitive, whole word).
const VARIANTS: Record<string, RegExp> = {
  Kisna: /\b(kismet|kishna|kisana|kisnaa|krishna diamond)\b/i,
  CaratLane: /\b(carat\s?tlin|carrot\s?lane|karat\s?lane|caratlen|carat\s+lane)\b/i,
  Tanishq: /\b(tanish|tanisq|tanishk|tanishka)\b/i,
  Malabar: /\b(malbar|malabaar)\b/i,
  BlueStone: /\b(blue\s+stone|bluestones)\b/i,
  Kalyan: /\b(kalyaan|kalian)\b/i,
  Dholakia: /\b(dholkia|dholakiya|dolakia)\b/i,
};

async function report(id: string) {
  const m = (await MeetingModel.findById(id).lean()) as MeetingDoc | null;
  if (!m) return { id, error: 'not found' };
  const d = await MeetingDataModel.findOne({ meetingId: m._id }).lean();
  const jobs = await JobModel.find({ meetingId: m._id, stage: { $ne: 'benchmark' } }).lean();
  const lines = d?.lines ?? [];
  const romanText = lines.map((l) => l.textRoman).join('\n');
  const words = romanText.split(/\s+/).filter(Boolean).length;
  const nativeWords = lines
    .map((l) => l.textNative)
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
  const scripts = {
    devanagariLines: lines.filter((l) => /[ऀ-ॿ]/.test(l.textNative)).length,
    gujaratiLines: lines.filter((l) => /[઀-૿]/.test(l.textNative)).length,
    romanWithIndicScript: lines.filter((l) => /[ऀ-ॿ઀-૿]/.test(l.textRoman)).length,
  };
  const longest = lines.reduce((x, l) => Math.max(x, l.end - l.start), 0);
  const shortLines = lines.filter((l) => SHORT.test(l.textRoman.trim()));
  const retries = jobs
    .filter((j) => j.attempts > 1 || j.lastError)
    .map(
      (j) =>
        `${j.stage}${j.step ?? ''}×${j.attempts}${j.lastError ? `: ${j.lastError.slice(0, 70)}` : ''}`,
    );
  const summary = m.summary ?? '';
  const glossary = SEED_GLOSSARY.map((e) => e.term).filter((t) =>
    new RegExp(`\\b${t}\\b`, 'i').test(romanText + summary),
  );
  const glossaryCounts = Object.fromEntries(
    glossary.map((t) => [t, (romanText.match(new RegExp(`\\b${t}\\b`, 'g')) ?? []).length]),
  );
  const misspellings = Object.entries(VARIANTS).flatMap(([term, re]) => {
    const hits = [...(romanText + '\n' + summary).matchAll(new RegExp(re.source, 'gi'))].map(
      (x) => x[0],
    );
    return hits.length ? [`${term} ← ${[...new Set(hits)].join(', ')} (${hits.length}×)`] : [];
  });
  const view = meetingView(m);
  return {
    id,
    title: m.title,
    durationMin: m.durationSec ? Math.round((m.durationSec / 60) * 10) / 10 : null,
    chunks: (d?.chunks ?? []).map((c) => `${c.index}:${c.status}@${c.model ?? '-'}`).join(' '),
    retries,
    turns: d?.turns.length ?? 0,
    lines: lines.length,
    distinctSpeakers: new Set(lines.map((l) => l.speakerName)).size,
    wordsRoman: words,
    wordsNative: nativeWords,
    scripts,
    coverage: m.coverage,
    status: m.status,
    summaryStatus: m.summaryStatus,
    cost: m.cost,
    wallClockMin:
      Math.round(
        ((new Date(m.updatedAt).getTime() - new Date(m.createdAt).getTime()) / 60000) * 10,
      ) / 10,
    longestLineSec: Math.round(longest * 10) / 10,
    linesOver45s: lines.filter((l) => l.end - l.start > 45).length,
    shortResponseLines: shortLines.length,
    shortResponseExamples: shortLines
      .slice(0, 3)
      .map(
        (l) =>
          `[${Math.floor(l.start / 60)}:${String(Math.floor(l.start % 60)).padStart(2, '0')}] ${l.speakerName}: ${l.textRoman}`,
      ),
    glossaryTermsFound: glossaryCounts,
    glossaryMisspellings: misspellings,
    summaryHygiene: {
      hasHorizontalRule: /^\s*-{3,}\s*$/m.test(summary),
      hasActionItemsMarker: /ACTION[_ ]ITEMS/i.test(summary),
      actionItemOwners: [...new Set(m.actionItems.map((a) => a.speakerName))],
      namesNextToSpeakerLabels: (summary.match(/Speaker \d+\s*\([^)]*\)/g) ?? []).slice(0, 5),
    },
    meetingRecordBytes: Buffer.byteLength(JSON.stringify({ meeting: view })),
  };
}

async function main(): Promise<void> {
  const cfg = env();
  await connectMongo(cfg.MONGODB_URI, cfg.MONGODB_DB);
  for (const id of process.argv.slice(2)) {
    if (!Types.ObjectId.isValid(id)) continue;
    console.log(JSON.stringify(await report(id), null, 1));
  }
  await disconnectMongo();
}

main().catch(async (err: unknown) => {
  console.error(err);
  await disconnectMongo().catch(() => undefined);
  process.exit(1);
});
