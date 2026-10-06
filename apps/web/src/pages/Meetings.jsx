import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Mic } from "lucide-react";
import { api } from "@/api/client";
import { fmtDuration } from "@/lib/format";

const BADGES = {
  processing: { label: "Processing", className: "text-muted-foreground", spin: true },
  uploaded: { label: "Queued", className: "text-muted-foreground", spin: true },
  partial: { label: "Partial", className: "text-amber-600" },
  failed: { label: "Failed", className: "text-destructive" },
  completed: { label: "Ready", className: "text-emerald-600" },
};

export default function Meetings() {
  const [meetings, setMeetings] = useState(null);

  const load = async () => {
    try {
      setMeetings(await api.meetings.list(50));
    } catch {
      setMeetings((m) => m ?? []);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!meetings || !meetings.some((m) => m.status === "processing")) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [meetings]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Meetings</h1>
          <p className="text-sm text-muted-foreground">MeetingID</p>
        </div>
        <Link
          to="/record"
          className="inline-flex items-center gap-2 text-sm font-medium px-4 py-2.5 rounded-full bg-foreground text-background"
        >
          <Mic className="w-4 h-4" /> New
        </Link>
      </div>

      {!meetings ? (
        <div className="flex justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : meetings.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <Mic className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <p className="mb-2">No meetings yet.</p>
          <Link to="/record" className="text-sm font-medium underline">
            Record your first meeting
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {meetings.map((m) => {
            const badge = BADGES[m.status];
            return (
              <Link
                key={m.id}
                to={`/meetings/${m.id}`}
                className="block rounded-2xl border border-border bg-card p-4 active:bg-secondary transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-semibold truncate">{m.title}</h3>
                  {badge && (
                    <span className={`flex items-center gap-1 text-xs shrink-0 ${badge.className}`}>
                      {badge.spin && <Loader2 className="w-3 h-3 animate-spin" />}
                      {badge.label}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {new Date(m.date).toLocaleString()}
                  {m.durationSec ? ` · ${fmtDuration(m.durationSec)}` : ""}
                  {m.coverage ? ` · ${Math.round(m.coverage.ratio * 100)}% transcribed` : ""}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
