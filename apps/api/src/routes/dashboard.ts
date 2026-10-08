import { Router } from 'express';
import { ws } from '../lib/auth.js';
import {
  EngineResponseModel,
  MeetingDataModel,
  MeetingModel,
  QuotaModel,
  SpendModel,
  type MeetingDoc,
  type SpeakerCardDoc,
} from '../models/index.js';
import { P2AuditModel, P2PyannoteResponseModel } from '../models/phase2.js';
import { tallyAudit } from '@meetingid/pipeline';

const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;

/** Cost and quality at a glance: what each meeting cost, how complete it is, how sure the speakers are. */
export function dashboardRouter(): Router {
  const r = Router();
  r.get('/dashboard', async (req, res) => {
    const workspaceId = ws(req)._id;
    const meetings = await MeetingModel.find({ workspaceId })
      .sort({ createdAt: -1 })
      .lean<MeetingDoc[]>();
    const ids = meetings.map((m) => m._id);
    const data = await MeetingDataModel.find(
      { meetingId: { $in: ids } },
      { meetingId: 1, speakerSource: 1, speakerCards: 1, lines: 1 },
    ).lean();
    const byId = new Map(data.map((d) => [String(d.meetingId), d]));

    const rows = meetings.map((m) => {
      const d = byId.get(String(m._id));
      const cards = (d?.speakerCards ?? []) as SpeakerCardDoc[];
      const count = (s: string) => cards.filter((c) => c.status === s).length;
      return {
        id: String(m._id),
        title: m.title,
        date: m.date,
        status: m.status,
        minutes: m.durationSec ? round(m.durationSec / 60, 1) : null,
        coverage: m.coverage?.ratio ?? null,
        speakers: new Set((d?.lines ?? []).map((l) => l.speakerName)).size,
        speakerSource: d?.speakerSource ?? 'text-fallback',
        voices: {
          confident: count('solid'),
          needsReview: count('review'),
          newVoices: count('new'),
          edited: count('manual'),
        },
        summary: m.summaryStatus,
        usd: round(m.cost?.usd ?? 0, 3),
        geminiTokens: (m.cost?.geminiInputTokens ?? 0) + (m.cost?.geminiOutputTokens ?? 0),
        deepgramMin: round((m.cost?.deepgramSec ?? 0) / 60, 1),
        claudeTokens: (m.cost?.claudeInputTokens ?? 0) + (m.cost?.claudeOutputTokens ?? 0),
      };
    });

    const engineCalls = await EngineResponseModel.aggregate<{
      _id: { engine: string; kind: string };
      n: number;
    }>([
      { $match: { meetingId: { $in: ids } } },
      { $group: { _id: { engine: '$engine', kind: '$kind' }, n: { $sum: 1 } } },
    ]);
    const pyannote = await P2PyannoteResponseModel.aggregate<{
      _id: { kind: string; status: string };
      n: number;
    }>([
      { $match: { meetingId: { $in: ids } } },
      { $group: { _id: { kind: '$kind', status: '$status' }, n: { $sum: 1 } } },
    ]);
    const diarizedIds = new Set(
      (
        await P2PyannoteResponseModel.find(
          { meetingId: { $in: ids }, kind: 'diarize', status: 'succeeded' },
          { meetingId: 1 },
        ).lean()
      ).map((x) => String(x.meetingId)),
    );
    const diarizedHours =
      meetings
        .filter((m) => diarizedIds.has(String(m._id)))
        .reduce((s, m) => s + (m.durationSec ?? 0), 0) / 3600;
    const spend = await SpendModel.findById('total').lean();
    const quotas = await QuotaModel.find({ exhaustedUntil: { $gt: new Date() } }).lean();
    const audits = await P2AuditModel.find({ workspaceId }).lean();
    const audit = tallyAudit(
      audits.flatMap((a) =>
        a.items.map((i) => ({ method: i.method, speaker: i.speaker, text: i.text })),
      ),
    );

    const measured = rows.filter((x) => x.coverage !== null);
    res.set('Cache-Control', 'no-store').json({
      totals: {
        meetings: rows.length,
        hours: round(rows.reduce((s, x) => s + (x.minutes ?? 0), 0) / 60, 1),
        usdRecorded: round(
          rows.reduce((s, x) => s + x.usd, 0),
          2,
        ),
        usdLedger: round(spend?.usd ?? 0, 2),
        ledgerByProvider: spend?.byProvider ?? {},
        averageCoverage: measured.length
          ? round(measured.reduce((s, x) => s + (x.coverage ?? 0), 0) / measured.length, 3)
          : null,
        belowNinety: measured.filter((x) => (x.coverage ?? 0) < 0.9).length,
        voiceBacked: rows.filter((x) => x.speakerSource === 'pyannote').length,
      },
      usage: {
        engineCalls: engineCalls.map((e) => ({
          engine: e._id.engine,
          kind: e._id.kind,
          calls: e.n,
        })),
        pyannoteJobs: pyannote.map((p) => ({ kind: p._id.kind, status: p._id.status, jobs: p.n })),
        pyannoteHours: round(diarizedHours, 1),
        pyannoteCostNote:
          'pyannote list prices (Developer plan, EUR): diarization 0.112 per audio hour (Starter 0.096), voiceprint 0.015 each; identification is billed by audio duration and its rate is not clearly listed. Plans include 19 / 99 of usage credit a month. Check pyannote billing for your contract.',
      },
      quotas: quotas.map((q) => ({ key: q._id, until: q.exhaustedUntil })),
      audit,
      meetings: rows,
    });
  });
  return r;
}
