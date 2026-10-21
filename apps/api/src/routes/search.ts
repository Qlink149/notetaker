import { Router } from 'express';
import { ws } from '../lib/auth.js';
import { MeetingDataModel, MeetingModel } from '../models/index.js';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A short stretch of `text` around the first word of the query. */
function snippet(text: string, words: string[]): string {
  const lower = text.toLowerCase();
  const at = Math.max(
    0,
    ...words
      .map((w) => lower.indexOf(w))
      .filter((i) => i >= 0)
      .slice(0, 1),
  );
  const start = Math.max(0, at - 50);
  return (
    (start > 0 ? '…' : '') +
    text.slice(start, start + 160).trim() +
    (start + 160 < text.length ? '…' : '')
  );
}

/**
 * Search meetings by title, summary, action items and what was said. Every word must appear (in any of
 * them); a meeting matched in its transcript shows the first line that has the first word, with its time.
 */
export function searchRouter(): Router {
  const r = Router();
  r.get('/search', async (req, res) => {
    const q = String(req.query.q ?? '')
      .trim()
      .slice(0, 100);
    const words = q
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .slice(0, 6);
    if (!words.length) {
      res.json({ results: [] });
      return;
    }
    const res_ = words.map((w) => new RegExp(escapeRe(w), 'i'));
    const meetings = await MeetingModel.find(
      { workspaceId: ws(req)._id },
      { title: 1, date: 1, summary: 1, actionItems: 1 },
    )
      .sort({ date: -1 })
      .limit(300)
      .lean();
    const ids = meetings.map((m) => m._id);
    // transcripts that contain every word somewhere
    const inLines = await MeetingDataModel.find(
      { meetingId: { $in: ids }, $and: res_.map((re) => ({ 'lines.textRoman': re })) },
      { meetingId: 1, lines: 1 },
    ).lean();
    const lineHit = new Map(
      inLines.map((d) => {
        const line = d.lines.find((l) => res_[0]!.test(l.textRoman ?? ''));
        return [String(d.meetingId), line ?? null];
      }),
    );
    const results = [];
    for (const m of meetings) {
      const head = [
        m.title,
        m.summary ?? '',
        ...(m.actionItems ?? []).map((a) => `${a.speakerName} ${a.text}`),
      ].join('\n');
      const line = lineHit.get(String(m._id));
      if (!line && !res_.every((re) => re.test(head))) continue;
      const inHead = res_.every((re) => re.test(head));
      const text = inHead
        ? (head.split('\n').find((s) => res_[0]!.test(s)) ?? m.title)
        : `${line!.speakerName}: ${line!.textRoman}`;
      results.push({
        meetingId: String(m._id),
        title: m.title,
        date: m.date.toISOString(),
        snippet: snippet(text, words),
        at: !inHead && line ? line.start : null,
      });
      if (results.length >= 40) break;
    }
    res.set('Cache-Control', 'no-store').json({ results });
  });
  return r;
}
