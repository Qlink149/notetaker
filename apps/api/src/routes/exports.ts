import { Router } from 'express';
import { z } from 'zod';
import { ws } from '../lib/auth.js';
import { HttpError, idParam, notFound } from '../lib/http.js';
import { MeetingDataModel, MeetingModel, type MeetingDoc } from '../models/index.js';
import { buildMeetingDocx } from '../services/export/docx.js';

const Query = z.object({
  format: z.enum(['docx']).default('docx'),
  script: z.enum(['roman', 'native', 'both']).default('roman'),
  // Missing means both, so older links and Save to Drive's caller stay unchanged.
  // `notes` is the summary (overview, decisions and the other sections) plus action items.
  parts: z
    .string()
    .optional()
    .superRefine((raw, ctx) => {
      if (raw === undefined) return;
      const items = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const known = items.every((item) => item === 'notes' || item === 'transcript');
      if (!known || items.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'parts' });
      }
    })
    .transform((raw) => {
      if (raw === undefined) return { notes: true, transcript: true };
      const items = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return { notes: items.includes('notes'), transcript: items.includes('transcript') };
    }),
});

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Meeting exports. PDF stays the browser's print-to-PDF: no browser engine is bundled on the server. */
export function exportsRouter(): Router {
  const r = Router();
  r.get('/meetings/:id/export', async (req, res) => {
    const { script, parts } = Query.parse(req.query);
    const m = await MeetingModel.findOne({
      _id: idParam(req),
      workspaceId: ws(req)._id,
    }).lean<MeetingDoc>();
    if (!m) throw notFound('meeting_not_found');
    const data = await MeetingDataModel.findOne({ meetingId: m._id }, { lines: 1 }).lean();
    if (!data?.lines.length) throw new HttpError(409, 'transcript_not_ready');
    const buf = await buildMeetingDocx({
      title: m.title,
      date: m.date ?? new Date(),
      durationSec: m.durationSec ?? null,
      summary: m.summary ?? null,
      actionItems: (m.actionItems ?? []).map((a) => ({ speakerName: a.speakerName, text: a.text })),
      lines: data.lines,
      scriptMode: script,
      notes: parts.notes,
      transcript: parts.transcript,
    });
    const ascii = m.title.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'meeting';
    res
      .set('Content-Type', DOCX)
      .set(
        'Content-Disposition',
        `attachment; filename="${ascii}.docx"; filename*=UTF-8''${encodeURIComponent(m.title)}.docx`,
      )
      .send(buf);
  });
  return r;
}
