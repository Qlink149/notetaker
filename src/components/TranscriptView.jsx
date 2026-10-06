import { useEffect, useRef } from "react";
import { UserX } from "lucide-react";

const PALETTE = [
  "bg-blue-100 text-blue-700",
  "bg-emerald-100 text-emerald-700",
  "bg-purple-100 text-purple-700",
  "bg-rose-100 text-rose-700",
  "bg-cyan-100 text-cyan-700",
  "bg-indigo-100 text-indigo-700",
];

function colorFor(name) {
  if (name.startsWith("Unknown")) return "bg-amber-200 text-amber-800";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function fmt(s) {
  if (s == null) return "";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Index of the transcript line covering the current playback position — the
// line whose [start, end] contains the time, else the most recent line that
// started before it.
function activeIndexFor(transcript, t) {
  if (!transcript || !transcript.length) return -1;
  for (let i = 0; i < transcript.length; i++) {
    const l = transcript[i];
    const end = l.end_time ?? l.start_time;
    if (t >= l.start_time && t <= end) return i;
  }
  let idx = -1;
  for (let i = 0; i < transcript.length; i++) {
    if (transcript[i].start_time <= t) idx = i;
    else break;
  }
  return idx;
}

export default function TranscriptView({ transcript, currentTime = 0, onSeek, scriptMode = "romanized" }) {
  const rowRefs = useRef([]);
  const firstRun = useRef(true);
  const active = activeIndexFor(transcript, currentTime);

  // Keep the active line in view as playback advances — but skip the initial
  // mount so the page doesn't jump past the summary / action items on load.
  useEffect(() => {
    if (active < 0) return;
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const el = rowRefs.current[active];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [active]);

  if (!transcript || !transcript.length)
    return <p className="text-sm text-muted-foreground">No transcript yet.</p>;

  return (
    <div className="space-y-3">
      {transcript.map((line, i) => {
        const unknown = line.speaker_name.startsWith("Unknown");
        const isActive = i === active;
        return (
          <div
            key={i}
            ref={(el) => (rowRefs.current[i] = el)}
            onClick={onSeek ? () => onSeek(line.start_time) : undefined}
            className={`rounded-xl p-3 transition-colors ${
              onSeek ? "cursor-pointer" : ""
            } ${
              isActive
                ? "bg-primary/5 border-2 border-primary/40 ring-1 ring-primary/30"
                : unknown
                ? "bg-amber-50 border border-amber-200"
                : "bg-card border border-border"
            }`}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className={`text-xs font-semibold px-2 py-0.5 rounded-full ${colorFor(
                  line.speaker_name
                )}`}
              >
                {line.speaker_name}
              </span>
              {unknown && <UserX className="w-3.5 h-3.5 text-amber-600" />}
              <span className="text-[10px] text-muted-foreground">
                {fmt(line.start_time)}
              </span>
            </div>
            {scriptMode === "both" && line.text_native && line.text_native !== line.text ? (
              <>
                <p className="text-sm leading-relaxed text-foreground">{line.text}</p>
                <p className="text-sm leading-relaxed text-muted-foreground mt-1 italic">{line.text_native}</p>
              </>
            ) : (
              <p className="text-sm leading-relaxed text-foreground">
                {scriptMode === "native" && line.text_native ? line.text_native : line.text}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}