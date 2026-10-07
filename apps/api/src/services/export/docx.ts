import { readFileSync } from 'node:fs';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

// Word export. Devanagari and Gujarati are written with embedded Noto fonts (SIL OFL, see
// assets/fonts/OFL.txt), so the file reads correctly on a computer that has neither installed.

const FONT_DIR = new URL('../../../assets/fonts/', import.meta.url);
const FONTS = [
  { name: 'Noto Sans Devanagari', file: 'NotoSansDevanagari-Regular.ttf' },
  { name: 'Noto Sans Gujarati', file: 'NotoSansGujarati-Regular.ttf' },
] as const;
let fontData: { name: string; data: Buffer }[] | null = null;
function fonts(): { name: string; data: Buffer }[] {
  fontData ??= FONTS.map((f) => ({ name: f.name, data: readFileSync(new URL(f.file, FONT_DIR)) }));
  return fontData;
}

export type ScriptMode = 'roman' | 'native' | 'both';

export interface ExportInput {
  title: string;
  date: Date;
  durationSec: number | null;
  summary: string | null;
  actionItems: { speakerName: string; text: string }[];
  lines: { speakerName: string; start: number; textRoman: string; textNative: string }[];
  scriptMode: ScriptMode;
}

const DEVANAGARI = /[ऀ-ॿ]/;
const GUJARATI = /[઀-૿]/;

/** Split text into runs by script so each run gets its own font. */
export function splitByScript(text: string): { text: string; font: string | null }[] {
  const out: { text: string; font: string | null }[] = [];
  for (const ch of text) {
    const font = DEVANAGARI.test(ch)
      ? 'Noto Sans Devanagari'
      : GUJARATI.test(ch)
        ? 'Noto Sans Gujarati'
        : null;
    const last = out[out.length - 1];
    // spaces and punctuation stay with the surrounding script
    const neutral = font === null && /[\s.,;:!?'"()\-–—।॥]/.test(ch);
    if (last && (last.font === font || (neutral && last.font !== null))) last.text += ch;
    else out.push({ text: ch, font });
  }
  return out;
}

function runs(
  text: string,
  opts: { bold?: boolean; color?: string; size?: number } = {},
): TextRun[] {
  return splitByScript(text).map(
    (seg) =>
      new TextRun({
        text: seg.text,
        bold: opts.bold,
        color: opts.color,
        size: opts.size,
        ...(seg.font
          ? { font: { ascii: seg.font, hAnsi: seg.font, cs: seg.font, eastAsia: seg.font } }
          : {}),
      }),
  );
}

/** `**bold**` inside a line of the summary. */
function inline(text: string): TextRun[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .flatMap((part) =>
      part.startsWith('**') && part.endsWith('**')
        ? runs(part.slice(2, -2), { bold: true })
        : runs(part),
    );
}

function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

function summaryParagraphs(md: string): Paragraph[] {
  return md.split(/\r?\n/).flatMap((raw) => {
    const line = raw.trimEnd();
    if (!line.trim()) return [];
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h)
      return [
        new Paragraph({
          heading: h[1]!.length === 1 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
          children: runs(h[2]!, { bold: true }),
          spacing: { before: 200, after: 80 },
        }),
      ];
    const b = /^\s*[-*]\s+(.*)$/.exec(line);
    if (b) return [new Paragraph({ bullet: { level: 0 }, children: inline(b[1]!) })];
    return [new Paragraph({ children: inline(line), spacing: { after: 80 } })];
  });
}

/** The meeting as a .docx: summary, action items and the transcript in the chosen script(s). */
export async function buildMeetingDocx(input: ExportInput): Promise<Buffer> {
  const body: Paragraph[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: runs(input.title) }),
    new Paragraph({
      children: runs(
        `${input.date.toLocaleString('en-IN')}${input.durationSec ? ` · ${Math.round(input.durationSec / 60)} min` : ''}`,
        { color: '666666', size: 20 },
      ),
      spacing: { after: 200 },
    }),
  ];
  if (input.summary) {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: runs('Summary') }));
    body.push(...summaryParagraphs(input.summary));
  }
  if (input.actionItems.length) {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: runs('Action items') }));
    for (const a of input.actionItems)
      body.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [...runs(`${a.speakerName}: `, { bold: true }), ...runs(a.text)],
        }),
      );
  }
  if (input.lines.length) {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: runs('Transcript') }));
    for (const l of input.lines) {
      const head = [
        ...runs(`[${mmss(l.start)}] `, { color: '888888', size: 18 }),
        ...runs(`${l.speakerName}: `, { bold: true }),
      ];
      const roman = l.textRoman || l.textNative;
      const native = l.textNative || l.textRoman;
      if (input.scriptMode === 'native') {
        body.push(new Paragraph({ children: [...head, ...runs(native)], spacing: { after: 80 } }));
      } else if (input.scriptMode === 'both' && l.textNative && l.textNative !== l.textRoman) {
        body.push(new Paragraph({ children: [...head, ...runs(roman)] }));
        body.push(
          new Paragraph({
            children: runs(native, { color: '555555' }),
            indent: { left: 360 },
            spacing: { after: 80 },
          }),
        );
      } else {
        body.push(new Paragraph({ children: [...head, ...runs(roman)], spacing: { after: 80 } }));
      }
    }
  }
  const doc = new Document({
    creator: 'MeetingID',
    title: input.title,
    fonts: fonts(),
    sections: [{ children: body }],
  });
  return Packer.toBuffer(doc);
}
