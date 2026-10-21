import { CheckCircle2, ListChecks } from "lucide-react";

// Action items grouped by the speaker responsible. Owners are the transcript's labels
// ("Speaker 2") or "Unassigned"; the summariser never guesses identities.
export default function ActionItems({ actionItems }) {
  if (!actionItems?.length) return null;

  const groups = new Map();
  for (const it of actionItems) {
    const key = it.speakerName || "Unassigned";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it.text);
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-4 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <ListChecks className="w-4 h-4 text-muted-foreground" />
        <h2 className="font-semibold">Action items</h2>
      </div>
      <div className="space-y-3">
        {[...groups.entries()].map(([speaker, items]) => (
          <div key={speaker}>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">{speaker}</p>
            <ul className="space-y-1.5">
              {items.map((t, i) => (
                <li key={i} className="text-sm flex gap-2">
                  <CheckCircle2 className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
