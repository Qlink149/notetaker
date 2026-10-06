import { CheckCircle2, ListChecks } from "lucide-react";

// Renders action items grouped by the speaker responsible for each.
// Handles both the new per-speaker format ({ speaker_name, text }) and the
// legacy format (plain strings), so older meetings still display.
export default function ActionItems({ actionItems }) {
  if (!actionItems || !actionItems.length) return null;

  const items = actionItems.map((a) =>
    typeof a === "string" ? { speaker_name: null, text: a } : a
  );

  const groups = {};
  const order = [];
  items.forEach((it) => {
    const key = it.speaker_name || "Unknown";
    if (!(key in groups)) {
      groups[key] = [];
      order.push(key);
    }
    groups[key].push(it.text);
  });

  return (
    <div className="rounded-2xl border border-border bg-card p-4 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <ListChecks className="w-4 h-4 text-muted-foreground" />
        <h2 className="font-semibold">Action items</h2>
      </div>
      <div className="space-y-3">
        {order.map((speaker) => (
          <div key={speaker}>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
              {speaker}
            </p>
            <ul className="space-y-1.5">
              {groups[speaker].map((t, i) => (
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