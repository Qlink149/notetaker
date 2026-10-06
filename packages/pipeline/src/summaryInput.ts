import type { Line } from '@meetingid/shared';
import { formatTimestamp } from './text.js';

/** Render lines as `[mm:ss] Speaker N: text` for the summariser. Roman text unless asked otherwise. */
export function formatLinesForSummary(lines: Line[], { includeNative = false } = {}): string {
  return lines
    .map((l) => {
      const native =
        includeNative && l.textNative && l.textNative !== l.textRoman ? ` / ${l.textNative}` : '';
      return `[${formatTimestamp(l.start)}] ${l.speakerName}: ${l.textRoman}${native}`;
    })
    .join('\n');
}

/** Split a transcript on line boundaries into pieces of at most `maxChars` characters. */
export function chunkTranscript(text: string, maxChars = 60_000): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > maxChars) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}
