import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  overlapRanges,
  selectClips,
  tallyAudit,
  type DiarizationOutput,
} from '@meetingid/pipeline';
import { ws } from '../lib/auth.js';
import { HttpError, body, notFound } from '../lib/http.js';
import { MeetingModel } from '../models/index.js';
import {
  P2AuditModel,
  P2JoinModel,
  P2PyannoteResponseModel,
  type P2AuditDoc,
} from '../models/phase2.js';
import { seedAudit } from '../services/audit.js';
import { shortTitle, speakerSeconds } from '../services/identity/identity.js';

// Blind audit of the speaker join (Block 1). The auditor first names each pyannote speaker from
// three clips, then judges sampled lines from M1 and M3 without being told which method made them.

const NamingBody = z.object({
  names: z.record(z.string().trim().max(100)).default({}),
  sameAs: z.record(z.string()).default({}),
});
const AnswerBody = z.object({
  speaker: z.enum(['right', 'wrong', 'unsure']).optional(),
  text: z.enum(['match', 'partly', 'no']).optional(),
});
const SeedBody = z.object({
  perMethod: z.number().int().min(3).max(60).default(15),
  force: z.boolean().default(false),
});

function canonical(diar: string, sameAs: Record<string, string>): string {
  const seen = new Set<string>();
  let cur = diar;
  while (sameAs[cur] && !seen.has(cur)) {
    seen.add(cur);
    cur = sameAs[cur]!;
  }
  return cur;
}

export function auditRouter(): Router {
  const r = Router();

  async function stageA(meetingId: string) {
    const doc = await P2PyannoteResponseModel.findOne({
      meetingId,
      kind: 'diarize',
      model: 'precision-2',
      tag: 'stageA',
      status: 'succeeded',
    }).lean();
    if (!doc) throw new HttpError(409, 'no_diarization');
    const out = doc.output as DiarizationOutput;
    return { exclusive: out.exclusiveDiarization ?? out.diarization, all: out.diarization };
  }

  async function ownMeeting(workspaceId: Types.ObjectId, id: string) {
    if (!Types.ObjectId.isValid(id)) throw notFound();
    const m = await MeetingModel.findOne({ _id: id, workspaceId }).lean();
    if (!m) throw notFound('meeting_not_found');
    return m;
  }

  r.get('/audit', async (req, res) => {
    // only meetings that have lines to judge (a recording still waiting for its transcript is left out)
    const ids = await P2JoinModel.distinct('meetingId', {
      method: 'm1',
      'lines.0': { $exists: true },
    });
    const meetings = await MeetingModel.find({
      _id: { $in: ids },
      workspaceId: ws(req)._id,
    }).lean();
    const audits = await P2AuditModel.find({ meetingId: { $in: ids } }).lean<P2AuditDoc[]>();
    res.json({
      meetings: meetings
        .map((m) => {
          const a = audits.find((x) => String(x.meetingId) === String(m._id));
          const items = a?.items ?? [];
          return {
            id: String(m._id),
            title: shortTitle(m.title),
            seeded: Boolean(a),
            items: items.length,
            answered: items.filter((i) => i.speaker).length,
            named: a ? Object.values(a.naming).filter(Boolean).length : 0,
          };
        })
        .sort((x, y) => x.title.localeCompare(y.title)),
    });
  });

  r.post('/audit/:meetingId/seed', async (req, res) => {
    const m = await ownMeeting(ws(req)._id, String(req.params.meetingId));
    const { perMethod, force } = body(SeedBody, req);
    const existing = await P2AuditModel.findOne({ meetingId: m._id }).lean<P2AuditDoc>();
    if (existing && !force) {
      res.json({ seeded: false, items: existing.items.length });
      return;
    }
    if (existing?.items.some((i) => i.speaker))
      throw new HttpError(409, 'Already answered; refusing to overwrite');
    const count = await seedAudit(String(m._id), ws(req)._id, perMethod);
    res.json({ seeded: true, items: count });
  });

  r.get('/audit/:meetingId', async (req, res) => {
    const m = await ownMeeting(ws(req)._id, String(req.params.meetingId));
    const audit = await P2AuditModel.findOne({ meetingId: m._id }).lean<P2AuditDoc>();
    if (!audit) throw new HttpError(409, 'not_seeded');
    const { exclusive, all } = await stageA(String(m._id));
    const join = await P2JoinModel.findOne({ meetingId: m._id, method: 'm1' }).lean();
    const labels = join?.speakerMap ?? {};
    const seconds = speakerSeconds(exclusive);
    const overlaps = overlapRanges(all);
    const meetingSec = m.durationSec ?? Math.max(...exclusive.map((s) => s.end));
    const clusters = [...seconds].map(([diar, sec]) => ({
      diar,
      label: labels[diar] ?? diar,
      seconds: Math.round(sec),
      name: audit.naming[diar] ?? '',
      sameAs: audit.sameAs[diar] ?? '',
      clips: selectClips({
        speaker: diar,
        exclusive,
        overlaps,
        meetingSec,
        maxClips: 3,
        minSec: 8,
        maxSec: 15,
        targetSec: 12,
      }),
    }));
    const assigned = (diar: string): string => {
      const c = canonical(diar, audit.sameAs);
      return audit.naming[c] || audit.naming[diar] || labels[c] || labels[diar] || diar;
    };
    res.json({
      meeting: { id: String(m._id), title: shortTitle(m.title), playbackUrl: m.audio.playbackUrl },
      clusters,
      items: audit.items.map((i) => ({
        id: i.id,
        start: i.start,
        end: i.end,
        assigned: assigned(i.diar),
        textRoman: i.textRoman,
        textNative: i.textNative,
        speaker: i.speaker,
        text: i.text,
      })),
    });
  });

  r.put('/audit/:meetingId/naming', async (req, res) => {
    const m = await ownMeeting(ws(req)._id, String(req.params.meetingId));
    const { names, sameAs } = body(NamingBody, req);
    const clean = Object.fromEntries(Object.entries(sameAs).filter(([k, v]) => v && v !== k));
    await P2AuditModel.updateOne({ meetingId: m._id }, { $set: { naming: names, sameAs: clean } });
    res.json({ ok: true });
  });

  r.patch('/audit/:meetingId/items/:itemId', async (req, res) => {
    const m = await ownMeeting(ws(req)._id, String(req.params.meetingId));
    const answer = body(AnswerBody, req);
    const audit = await P2AuditModel.findOne({ meetingId: m._id }).lean<P2AuditDoc>();
    const items = audit?.items;
    const item = items?.find((i) => i.id === req.params.itemId);
    if (!audit || !items || !item) throw notFound('item_not_found');
    if (answer.speaker) item.speaker = answer.speaker;
    if (answer.text) item.text = answer.text;
    item.answeredAt = new Date();
    await P2AuditModel.updateOne({ meetingId: m._id }, { $set: { items } });
    res.json({ ok: true });
  });

  /** Per method: speaker-correct rate, wrong-name rate and text-match rate, with counts. */
  r.get('/audit/results/all', async (req, res) => {
    const audits = await P2AuditModel.find({ workspaceId: ws(req)._id }).lean<P2AuditDoc[]>();
    const answers = audits.flatMap((a) =>
      a.items.map((i) => ({ method: i.method, speaker: i.speaker, text: i.text, short: i.short })),
    );
    res.json({
      methods: tallyAudit(answers),
      shortLines: tallyAudit(answers.filter((a) => a.short)),
      note: 'Rates are over answered items. The method is hidden while auditing.',
    });
  });

  return r;
}
