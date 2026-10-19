import type { ActionItem } from '@meetingid/shared';

/**
 * Update a written summary after speakers were renamed, without writing a new one (client request, 20 Oct:
 * "the existing summary is correct except where Speaker A was identified and later renamed; a new summary is
 * unnecessary unless required"). The summariser is told to use the speaker names exactly as they appear in the
 * transcript, so the names in the summary are those of the speaker map it was written with (`from`); this swaps
 * them for the current ones (`to`). When a plain swap could make the summary wrong, it says so instead
 * (`needs_refresh`) and leaves the text alone: two speakers joined into one, one split in two, two voices now
 * carrying the same name, or an old name that is also a person talked about in the meeting.
 */
export type SummaryRenameStatus = 'unchanged' | 'updated' | 'needs_refresh';

export interface SummaryRenameInput {
  summary: string;
  actionItems: ActionItem[];
  /** Speaker id → name the summary was written with. */
  from: Record<string, string>;
  /** Speaker id → current name. */
  to: Record<string, string>;
  /** What was said (the transcript's text), to tell a speaker's name from a person mentioned in the talk. */
  spokenText: string;
}

export interface SummaryRenameResult {
  summary: string;
  actionItems: ActionItem[];
  status: SummaryRenameStatus;
  reasons: string[];
  renames: { from: string; to: string }[];
}

/** Placeholder labels and the catch-all speaker are not names anyone says aloud. */
const GENERIC = /^(Speaker [A-Z]{1,3}|Unknown|Unassigned)$/;
const IGNORED_IDS = new Set(['unknown']);

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The name as a whole word: "Speaker A" is not part of "Speaker AB", "Ravi" not of "Raviraj". */
const wordRe = (name: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${escape(name)}(?![\\p{L}\\p{N}_])`, 'gu');
const mentions = (text: string, name: string): boolean => wordRe(name).test(text);

export function renameInSummary(input: SummaryRenameInput): SummaryRenameResult {
  const { summary, actionItems, spokenText } = input;
  const from = Object.fromEntries(Object.entries(input.from).filter(([k]) => !IGNORED_IDS.has(k)));
  const to = Object.fromEntries(Object.entries(input.to).filter(([k]) => !IGNORED_IDS.has(k)));
  const reasons: string[] = [];
  const written = (name: string): boolean =>
    mentions(summary, name) ||
    actionItems.some((a) => a.speakerName === name || mentions(a.text, name));

  // renames, per speaker
  const pairs = new Map<string, string>();
  for (const [id, old] of Object.entries(from)) {
    const now = to[id];
    if (now === undefined) {
      // the speaker is gone (joined into another): its part of the summary may now belong to someone else
      if (written(old)) reasons.push(`"${old}" was joined into another speaker`);
      continue;
    }
    if (now !== old) {
      if (pairs.has(old) && pairs.get(old) !== now)
        reasons.push(`"${old}" was renamed to two different names`);
      pairs.set(old, now);
    }
  }
  for (const id of Object.keys(to))
    if (!(id in from)) reasons.push(`a new speaker "${to[id]}" was split from another`);

  // two different voices now carry the same name: the summary would merge what they said
  const owners = new Map<string, Set<string>>();
  for (const [id, name] of Object.entries(to)) {
    const was = from[id] ?? name;
    owners.set(name, (owners.get(name) ?? new Set()).add(was));
  }
  for (const [name, olds] of owners)
    if (olds.size > 1 && [...olds].some((o) => pairs.has(o) || o !== name))
      reasons.push(`two speakers are now both "${name}"`);

  const renames = [...pairs].map(([f, t]) => ({ from: f, to: t }));
  // an old real name that is also said in the meeting may be someone talked about, not the speaker
  // (completing a name, "Heet" → "Heet Dholakia", keeps the same person: safe however often it is said)
  const ambiguous = renames.filter(
    (r) => !GENERIC.test(r.from) && !r.to.startsWith(`${r.from} `) && mentions(spokenText, r.from),
  );
  for (const r of ambiguous)
    reasons.push(
      `"${r.from}" is also mentioned in the conversation, so the summary may mean another person`,
    );

  if (!renames.length && !reasons.length)
    return { summary, actionItems, status: 'unchanged', reasons, renames };

  // Owners of action items are structured fields: renaming them is always safe.
  const owner = (n: string): string => pairs.get(n) ?? n;
  if (reasons.length) {
    const items = actionItems.map((a) => ({ ...a, speakerName: owner(a.speakerName) }));
    return { summary, actionItems: items, status: 'needs_refresh', reasons, renames };
  }

  // Swap through placeholders so A↔B swaps and chains work, and a longer name is never cut by a shorter one
  // ("Ravi Shah" is protected before "Ravi" is replaced).
  const names = [...new Set([...Object.values(from), ...pairs.keys()])].sort(
    (a, b) => b.length - a.length,
  );
  const token = (i: number): string => `\u0000${i}\u0000`;
  const swap = (text: string): string => {
    let out = text;
    names.forEach((n, i) => (out = out.replace(wordRe(n), token(i))));
    names.forEach((n, i) => (out = out.split(token(i)).join(owner(n))));
    return out;
  };
  const next = swap(summary);
  const items = actionItems.map((a) => ({ speakerName: owner(a.speakerName), text: swap(a.text) }));
  const changed =
    next !== summary ||
    items.some(
      (a, i) => a.speakerName !== actionItems[i]!.speakerName || a.text !== actionItems[i]!.text,
    );
  return {
    summary: next,
    actionItems: items,
    status: changed ? 'updated' : 'unchanged',
    reasons,
    renames,
  };
}
