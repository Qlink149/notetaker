import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Loader2, Play, ArrowLeft, Gauge } from "lucide-react";
import { Link } from "react-router-dom";

export default function Benchmark() {
  const [meetings, setMeetings] = useState([]);
  const [selected, setSelected] = useState(null);
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    base44.entities.Meeting.list("-created_date", 50).then((list) => {
      setMeetings(list.filter((m) => m.cloudinary_public_id));
    }).catch(() => {});
  }, []);

  const run = async () => {
    if (!selected) return;
    setRunning(true);
    setResults(null);
    try {
      const res = await base44.functions.invoke("benchmarkEngines", { meeting_id: selected });
      setResults(res);
    } catch (e) {
      setResults({ error: e.message });
    }
    setRunning(false);
  };

  return (
    <div>
      <Link to="/" className="inline-flex items-center text-sm text-muted-foreground mb-3">
        <ArrowLeft className="w-4 h-4 mr-1" /> Meetings
      </Link>
      <div className="flex items-center gap-2 mb-1">
        <Gauge className="w-5 h-5 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">Engine Benchmark</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Compare transcription engines on the same audio. Does not modify the meeting.
      </p>

      <div className="space-y-2 mb-6">
        <label className="text-sm font-medium">Select a meeting with audio</label>
        {meetings.length === 0 && (
          <p className="text-sm text-muted-foreground">No meetings with Cloudinary audio found.</p>
        )}
        {meetings.map((m) => (
          <button
            key={m.id}
            onClick={() => setSelected(m.id)}
            className={`w-full text-left p-3 rounded-xl border transition-colors ${
              selected === m.id ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-accent"
            }`}
          >
            <p className="font-medium text-sm">{m.title}</p>
            <p className="text-xs text-muted-foreground">
              {Math.round((m.duration_seconds || 0) / 60)} min · {m.language_mode?.join(", ") || "unknown"}
            </p>
          </button>
        ))}
      </div>

      <Button onClick={run} disabled={!selected || running} className="w-full mb-6">
        {running ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
        {running ? "Running benchmark…" : "Run benchmark"}
      </Button>

      {results && !results.error && (
        <div className="space-y-4">
          <p className="text-sm font-medium">
            {results.title} · {Math.round((results.duration_seconds || 0) / 60)} min
          </p>
          {["deepgram", "gemini", "openai"].map((engine) => {
            const r = results.results?.[engine];
            if (!r) return null;
            return (
              <div key={engine} className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold capitalize">{engine}</h3>
                  {r.error ? (
                    <span className="text-xs text-destructive">Failed</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {r.utterances} utterances · {(r.duration_ms / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
                {r.error ? (
                  <p className="text-sm text-destructive">{r.error}</p>
                ) : (
                  <div className="space-y-1.5">
                    {r.sample?.map((u, i) => (
                      <p key={i} className="text-xs text-muted-foreground">
                        <span className="font-mono text-foreground">
                          {Math.floor(u.start / 60)}:{String(Math.floor(u.start % 60)).padStart(2, "0")}
                        </span>{" "}
                        {u.text}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {results?.error && <p className="text-sm text-destructive">{results.error}</p>}
    </div>
  );
}