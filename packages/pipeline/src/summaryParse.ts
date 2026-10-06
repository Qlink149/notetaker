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
