import { useEffect, useState } from "react";
import { Loader2, Play, Save } from "lucide-react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtTime } from "@/lib/format";

const ENGINES = [
  { id: "gemini", label: "Gemini" },
  { id: "deepgram", label: "Deepgram" },
  { id: "gemini-transcribe", label: "Gemini Transcribe" },
];

const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);

function ResultColumn({ result, title }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3 min-w-0">
      <div className="flex items-center justify-between mb-2">
        <p className="font-semibold text-sm">{result.engine}</p>
        <span className="text-xs text-muted-foreground">{result.model}</span>
      </div>
      {result.status === "pending" && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" /> Running on {title}…
        </p>
      )}
      {result.status === "failed" && <p className="text-xs text-destructive">{result.error}</p>}
      {result.status === "done" && (
        <>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs mb-3">
            <dt className="text-muted-foreground">Coverage</dt><dd className="tabular-nums">{pct(result.coverage)}</dd>
            <dt className="text-muted-foreground">Words</dt><dd className="tabular-nums">{result.words}</dd>
            <dt className="text-muted-foreground">Turns</dt><dd className="tabular-nums">{result.turns}</dd>
            <dt className="text-muted-foreground">Latency</dt><dd className="tabular-nums">{(result.durationMs / 1000).toFixed(1)} s</dd>
            <dt className="text-muted-foreground">Tokens in/out</dt><dd className="tabular-nums">{result.costTokens.input}/{result.costTokens.output}</dd>
            <dt className="text-muted-foreground">Audio billed</dt><dd className="tabular-nums">{Math.round(result.costTokens.audioSec)} s</dd>
          </dl>
          <div className="max-h-[28rem] overflow-y-auto space-y-1.5 text-xs border-t border-border pt-2">
            {result.transcriptLines.map((l, i) => (
              <p key={i}>
                <span className="text-muted-foreground tabular-nums">{fmtTime(l.start)}</span>{" "}
                <span className="font-semibold">{l.speakerName}:</span> {l.textRoman}
              </p>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function Benchmark() {
  const [meetings, setMeetings] = useState([]);
  const [selected, setSelected] = useState([]);
  const [engines, setEngines] = useState(["gemini", "deepgram"]);
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [setName, setSetName] = useState("");
  const [promoted, setPromoted] = useState("");

  useEffect(() => {
    // Only meetings that finished ingest have chunk audio to benchmark against.
    api.meetings.list(50).then((list) => setMeetings(list.filter((m) => m.progress.chunksTotal > 0))).catch(() => {});
    api.benchmark.runs().then((runs) => runs[0] && api.benchmark.get(runs[0].id).then(setRun)).catch(() => {});
  }, []);

  useEffect(() => {
    if (run?.status !== "running") return;
    const t = setInterval(() => api.benchmark.get(run.id).then(setRun).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [run?.id, run?.status]);

  const toggle = (list, setList, id) => setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      setRun(await api.benchmark.run(selected, engines));
    } catch (e) {
      setError(e?.message || "Benchmark failed to start.");
    } finally {
      setBusy(false);
    }
  };

  const promote = async () => {
    try {
      const { evalSet } = await api.benchmark.promote(setName.trim(), run.meetingIds);
      setPromoted(`Saved eval set "${evalSet.name}" (${evalSet.size} meetings).`);
      setSetName("");
    } catch (e) {
      setError(e?.message || "Could not save the eval set.");
    }
  };

  const titleOf = (id) => meetings.find((m) => m.id === id)?.title ?? id;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Engine benchmark</h1>
        <p className="text-sm text-muted-foreground">Run engines on the same processed meetings and compare transcripts side by side.</p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 space-y-4">
        <div>
          <p className="text-sm font-medium mb-2">Meetings</p>
          {meetings.length === 0 ? (
            <p className="text-xs text-muted-foreground">No processed meetings yet.</p>
          ) : (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {meetings.map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={selected.includes(m.id)} onChange={() => toggle(selected, setSelected, m.id)} />
                  <span className="truncate">{m.title}</span>
                  <span className="text-xs text-muted-foreground shrink-0">{m.durationSec ? `${Math.round(m.durationSec / 60)} min` : ""}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <div>
          <p className="text-sm font-medium mb-2">Engines</p>
          <div className="flex flex-wrap gap-3">
            {ENGINES.map((e) => (
              <label key={e.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={engines.includes(e.id)} onChange={() => toggle(engines, setEngines, e.id)} />
                {e.label}
              </label>
            ))}
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button onClick={start} disabled={busy || !selected.length || !engines.length} className="rounded-full">
          {busy ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Play className="w-4 h-4 mr-1" />} Run benchmark
        </Button>
      </div>

      {run && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">
              Run of {new Date(run.createdAt).toLocaleString()}{" "}
              {run.status === "running" && <Loader2 className="w-4 h-4 inline animate-spin text-muted-foreground" />}
            </h2>
          </div>
          {run.meetingIds.map((mid) => (
            <div key={mid} className="space-y-2">
              <p className="text-sm font-medium">{titleOf(mid)}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {run.results.filter((r) => r.meetingId === mid).map((r) => (
                  <ResultColumn key={r.engine} result={r} title={titleOf(mid)} />
                ))}
              </div>
            </div>
          ))}
          <div className="rounded-2xl border border-border bg-card p-4 space-y-2">
            <p className="text-sm font-medium">Promote these meetings to an eval set</p>
            <div className="flex gap-2">
              <Input value={setName} onChange={(e) => setSetName(e.target.value)} placeholder="Eval set name" aria-label="Eval set name" />
              <Button variant="outline" onClick={promote} disabled={!setName.trim()}>
                <Save className="w-4 h-4 mr-1" /> Save
              </Button>
            </div>
            {promoted && <p className="text-xs text-emerald-600">{promoted}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
