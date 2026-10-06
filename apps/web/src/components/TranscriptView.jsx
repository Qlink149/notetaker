import { useEffect, useRef } from "react";
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

/** scriptMode: "roman" | "native" | "both". Lines never exceed 45 s (built server-side). */
export default function TranscriptView({ lines, currentTime = 0, onSeek, scriptMode = "roman" }) {
  const rowRefs = useRef([]);
  const firstRun = useRef(true);
  const active = activeIndexFor(lines, currentTime);

  // Keep the active line in view during playback, but don't jump on first render.
  useEffect(() => {
    if (active < 0) return;
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    rowRefs.current[active]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [active]);

  if (!lines?.length) return <p className="text-sm text-muted-foreground">No transcript yet.</p>;

  return (
    <div className="space-y-3">
      {lines.map((line, i) => {
        const isActive = i === active;
        const showBoth = scriptMode === "both" && line.textNative && line.textNative !== line.textRoman;
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
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${colorFor(line.speakerName)}`}>
                {line.speakerName}
              </span>
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
          </div>
        );
      })}
    </div>
  );
}
