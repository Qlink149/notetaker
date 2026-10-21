import type { MeetingDataDoc, MeetingDoc } from '../../models/index.js';
import { buildMeetingDocx } from '../export/docx.js';

/**
 * What a meeting looks like in Google Drive: its file name and content. For now the content is the Word export
 * (summary, action items, transcript); the client's own format (promised 21 Oct) replaces this one function.
 */
export async function driveDocument(
  m: MeetingDoc,
  data: Pick<MeetingDataDoc, 'lines'>,
): Promise<{ name: string; docx: Buffer }> {
  const date = m.date ?? new Date();
  const day = new Date(date.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const docx = await buildMeetingDocx({
    title: m.title,
    date,
    durationSec: m.durationSec ?? null,
    summary: m.summary ?? null,
    actionItems: (m.actionItems ?? []).map((a) => ({ speakerName: a.speakerName, text: a.text })),
    lines: data.lines,
    scriptMode: 'roman',
  });
  return { name: `${day} · ${m.title}`, docx };
}
