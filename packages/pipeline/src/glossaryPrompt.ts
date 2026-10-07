import type { Glossary, GlossaryKind } from '@meetingid/shared';

const KIND_ORDER: { kind: GlossaryKind; label: string }[] = [
  { kind: 'company', label: 'Company' },
  { kind: 'person', label: 'People' },
  { kind: 'competitor', label: 'Competitors' },
  { kind: 'agency', label: 'Agencies' },
  { kind: 'product', label: 'Products' },
  { kind: 'place', label: 'Places' },
  { kind: 'other', label: 'Other terms' },
];

/**
 * Render the glossary as one compact block for engine and summary prompts, grouped by kind:
 * `Company: Kisna (also: Kisna Diamond & Gold). People: Ghanshyam Dholakia; Heet Dholakia.`
 */
export function renderGlossaryForPrompt(glossary: Glossary | null | undefined): string {
  if (!glossary?.entries.length) return '';
  const groups: string[] = [];
  for (const { kind, label } of KIND_ORDER) {
    const items = glossary.entries
      .filter((e) => e.kind === kind)
      .map((e) => {
        const aliases = e.aliases.filter((a) => a && a !== e.term);
        const note = e.note ? ` [${e.note}]` : '';
        return aliases.length
          ? `${e.term} (also: ${aliases.join(', ')})${note}`
          : `${e.term}${note}`;
      });
    if (items.length) groups.push(`${label}: ${items.join('; ')}.`);
  }
  return groups.join(' ');
}

/** Flat, de-duplicated list of terms (canonical spellings first, then aliases) for keyword boosting. */
export function glossaryKeyterms(glossary: Glossary | null | undefined, max = 100): string[] {
  if (!glossary) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (t: string): void => {
    const k = t.trim();
    if (!k || seen.has(k.toLowerCase())) return;
    seen.add(k.toLowerCase());
    out.push(k);
  };
  for (const e of glossary.entries) add(e.term);
  for (const e of glossary.entries) for (const a of e.aliases) add(a);
  return out.slice(0, max);
}
