import { z } from 'zod';
import type { ActionItem } from '@meetingid/shared';

const SummaryJson = z.object({
  summary_markdown: z.string().min(1),
  action_items: z.array(z.object({ speaker_name: z.string(), text: z.string().min(1) })),
});

export interface ParsedSummary {
  summaryMarkdown: string;
  actionItems: ActionItem[];
}

export type SummaryParseResult = { ok: true; value: ParsedSummary } | { ok: false; error: string };

/** Speaker name used for an action item whose owner the model could not take from the transcript. */
export const UNASSIGNED = 'Unassigned';

/** Strip a ```json fence and anything outside the outermost JSON object. */
function extractJson(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  return start >= 0 && end > start ? t.slice(start, end + 1) : t;
}

/** Remove stray horizontal rules and ACTION_ITEMS markers the prompt forbids. */
function cleanMarkdown(md: string): string {
  return md
    .split('\n')
    .filter((line) => !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line))
    .filter((line) => !/^\s*#*\s*\**\s*ACTION[_ ]ITEMS\b/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Keep action-item owners to names that actually appear in the transcript. A guessed identity in
 * parentheses ("Speaker 1 (Shital)") is stripped; anything still unknown becomes `Unassigned`.
 */
function normaliseOwner(name: string, allowed: Set<string> | null): string {
  const bare = name.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  if (!allowed) return bare || UNASSIGNED;
  if (allowed.has(name)) return name;
  if (allowed.has(bare)) return bare;
  return UNASSIGNED;
}

/**
 * Strictly parse the summariser's single JSON object. Tolerates a code fence around it; rejects
 * anything that does not match the schema.
 */
export function parseSummary(text: string, allowedSpeakers?: string[]): SummaryParseResult {
  if (!text?.trim()) return { ok: false, error: 'empty response' };
  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(text));
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  const parsed = SummaryJson.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `schema: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`,
    };
  }
  const allowed = allowedSpeakers ? new Set(allowedSpeakers) : null;
  const seen = new Set<string>();
  const actionItems: ActionItem[] = [];
  for (const item of parsed.data.action_items) {
    const text = item.text.trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    actionItems.push({ speakerName: normaliseOwner(item.speaker_name, allowed), text });
  }
  return {
    ok: true,
    value: { summaryMarkdown: cleanMarkdown(parsed.data.summary_markdown), actionItems },
  };
}

/** The sections the summariser must always write, in this order. */
export const REQUIRED_SECTIONS = [
  'Overview',
  'Key Topics',
  'Decisions',
  'Insights',
  'Open Questions',
] as const;

/**
 * The title of a Markdown heading line, lower-cased, or null when the line is not a heading. Tolerates the variations a
 * model produces: "### Key topics:", "## 2. Decisions", "## **Insights**", "## _Insights_".
 */
function headingTitle(line: string): string | null {
  const t = line.trimStart();
  if (line.length - t.length > 3) return null;
  let hashes = 0;
  while (t[hashes] === '#') hashes++;
  if (hashes < 1 || hashes > 4) return null;
  let rest = t.slice(hashes).trim();
  let digits = 0;
  while (digits < rest.length && rest[digits]! >= '0' && rest[digits]! <= '9') digits++;
  if (digits > 0 && (rest[digits] === '.' || rest[digits] === ')'))
    rest = rest.slice(digits + 1).trim();
  rest = rest.split('*').join('').split('_').join('').trim();
  return rest.toLowerCase().split(' ').filter(Boolean).join(' ');
}

/** "key topics" and "key topic" both count; so do the other sections in the singular. */
const titlesFor = (name: string): string[] => {
  const full = name.toLowerCase();
  return full.endsWith('s') ? [full, full.slice(0, -1)] : [full];
};

/**
 * Whether a heading title is this section: the name itself, or the name followed by a separator and a remark
 * ("decisions:", "decisions (none)", "decisions - none"). A longer title such as "decisions made later" is a different
 * heading.
 */
function isSection(title: string, name: string): boolean {
  return titlesFor(name).some((t) => {
    if (title === t) return true;
    if (!title.startsWith(t)) return false;
    const after = title.slice(t.length).trimStart();
    return [':', '(', '-', '–', '—'].some((sep) => after.startsWith(sep));
  });
}

const NEWLINE = String.fromCharCode(10);

/** Required sections that have no heading in the summary (heading case, numbering and emphasis are tolerated). */
export function missingSections(markdown: string): string[] {
  const titles: string[] = [];
  let fenced = false;
  for (const line of markdown.split(NEWLINE)) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced; // a heading shown inside a code block is not a heading
      continue;
    }
    if (fenced) continue;
    const title = headingTitle(line);
    if (title) titles.push(title);
  }
  return REQUIRED_SECTIONS.filter((name) => !titles.some((title) => isSection(title, name)));
}

/** The line written under a section that the summariser did not produce. */
export const SECTION_NOT_PRODUCED = 'Not produced this time. Use Refresh summary to try again.';

/**
 * Last resort when the summariser still leaves sections out after being asked again: add each missing heading with an
 * honest line saying so, instead of saving a summary that silently lacks them. Nothing is invented.
 */
export function repairSections(markdown: string): string {
  const missing = missingSections(markdown);
  if (!missing.length) return markdown;
  const added = missing.map((name) => `## ${name}\n${SECTION_NOT_PRODUCED}`).join('\n\n');
  return `${markdown.trimEnd()}\n\n${added}`;
}
