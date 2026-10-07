import { useEffect, useRef, useState } from "react";
import { fmtTime, lineText } from "@/lib/format";

const PALETTE = [
  "bg-blue-100 text-blue-700",
  "bg-emerald-100 text-emerald-700",
  "bg-purple-100 text-purple-700",
  "bg-rose-100 text-rose-700",
  "bg-cyan-100 text-cyan-700",
  "bg-indigo-100 text-indigo-700",
];

function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// The line covering the playback position, else the most recent line that started before it.
function activeIndexFor(lines, t) {
  if (!lines?.length) return -1;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (t >= lines[i].start && t <= lines[i].end) return i;
    if (lines[i].start <= t) idx = i;
    else break;
  }
  return idx;
}

/**
 * scriptMode: "roman" | "native" | "both". Lines never exceed 45 s (built server-side).
 * When `onReassign` / `onSplit` are given, clicking a speaker's name opens line actions:
 * `speakers` is [{ diar, displayName }] of the meeting.
 */
export default function TranscriptView({
  lines,
  currentTime = 0,
  onSeek,
  scriptMode = "roman",
  speakers = [],
  onReassign,
  onSplit,
}) {
  const rowRefs = useRef([]);
  const firstRun = useRef(true);
  const [menu, setMenu] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = activeIndexFor(lines, currentTime);
  const editable = Boolean(onReassign || onSplit);

  // Keep the active line in view during playback, but don't jump on first render.
  useEffect(() => {
    if (active < 0) return;
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    rowRefs.current[active]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [active]);

  const act = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setMenu(-1);
    } catch (e) {
      setError(e?.message || "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  if (!lines?.length) return <p className="text-sm text-muted-foreground">No transcript yet.</p>;

  return (
    <div className="space-y-3">
      {lines.map((line, i) => {
        const isActive = i === active;
        const showBoth = scriptMode === "both" && line.textNative && line.textNative !== line.textRoman;
        const chipClass = `text-xs font-semibold px-2 py-0.5 rounded-full ${colorFor(line.speakerName)}`;
        return (
          <div
            key={i}
            ref={(el) => (rowRefs.current[i] = el)}
            onClick={onSeek ? () => onSeek(line.start) : undefined}
            className={`rounded-xl p-3 transition-colors ${onSeek ? "cursor-pointer" : ""} ${
              isActive ? "bg-primary/5 border-2 border-primary/40 ring-1 ring-primary/30" : "bg-card border border-border"
            }`}
          >
            <div className="flex items-center gap-2 mb-1.5">
              {editable ? (
                <button
                  type="button"
                  className={`${chipClass} underline decoration-dotted underline-offset-2`}
                  aria-expanded={menu === i}
                  aria-label={`${line.speakerName}: change who said this`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu(menu === i ? -1 : i);
                    setError("");
                  }}
                >
                  {line.speakerName}
                </button>
              ) : (
                <span className={chipClass}>{line.speakerName}</span>
              )}
              <span className="text-[10px] text-muted-foreground tabular-nums">{fmtTime(line.start)}</span>
            </div>
            {showBoth ? (
              <>
                <p className="text-sm leading-relaxed text-foreground">{line.textRoman}</p>
                <p className="text-sm leading-relaxed text-muted-foreground mt-1">{line.textNative}</p>
              </>
            ) : (
              <p className="text-sm leading-relaxed text-foreground">
                {lineText(line, scriptMode === "native" ? "native" : "roman")}
              </p>
            )}
            {editable && menu === i && (
              <div
                className="mt-2.5 pt-2.5 border-t border-border flex flex-wrap items-center gap-2 text-xs"
                onClick={(e) => e.stopPropagation()}
              >
                {onReassign && (
                  <label className="flex items-center gap-1.5">
                    Move this line to
                    <select
                      disabled={busy}
                      defaultValue=""
                      onChange={(e) => e.target.value && act(() => onReassign(i, e.target.value))}
                      className="h-8 rounded-md border border-input bg-background px-2"
                    >
                      <option value="">choose…</option>
                      {speakers
                        .filter((s) => s.displayName !== line.speakerName)
                        .map((s) => (
                          <option key={s.diar} value={s.diar}>{s.displayName}</option>
                        ))}
                    </select>
                  </label>
                )}
                {onSplit && (
                  <button
                    disabled={busy}
                    onClick={() => act(() => onSplit(i))}
                    className="h-8 px-2.5 rounded-md border border-input hover:bg-secondary"
                  >
                    This is a different person from here on
                  </button>
                )}
                {error && <span className="text-destructive">{error}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
