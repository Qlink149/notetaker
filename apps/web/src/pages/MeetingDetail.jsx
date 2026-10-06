import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import {
  Loader2, ArrowLeft, AlertTriangle, Sparkles, Pencil, Check, RefreshCw, Trash2,
  Upload, FileText, GitMerge,
} from "lucide-react";
import { api } from "@/api/client";
import { useAuth } from "@/lib/AuthContext";
import { fmtDuration } from "@/lib/format";
import TranscriptView from "@/components/TranscriptView";
import ActionItems from "@/components/ActionItems";
import MeetingExport from "@/components/MeetingExport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const STAGES = ["ingest", "transcribe", "assemble", "summarise", "finalise", "done"];
const STEPS = [
  { key: "ingest", label: "Preparing audio", icon: Upload },
  { key: "transcribe", label: "Transcribing", icon: FileText },
  { key: "assemble", label: "Assembling transcript", icon: GitMerge },
  { key: "summarise", label: "Summarising", icon: Sparkles },
];
const STAGE_LABEL = { ingest: "preparing audio", transcribe: "transcription", assemble: "assembly", summarise: "summary", finalise: "finishing" };

const stageIdx = (s) => Math.max(0, STAGES.indexOf(s));

function progressPct(m) {
  const { chunksDone, chunksTotal } = m.progress ?? {};
  switch (m.stage) {
    case "ingest": return 5;
    case "transcribe": return 10 + Math.round(70 * (chunksTotal ? chunksDone / chunksTotal : 0));
    case "assemble": return 85;
    case "summarise": return 92;
    case "finalise": return 98;
    default: return 100;
  }
}

const SCRIPT_MODES = [
  { mode: "roman", label: "Roman" },
  { mode: "native", label: "Native" },
  { mode: "both", label: "Both" },
];

export default function MeetingDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { workspace } = useAuth();
  const [meeting, setMeeting] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scriptMode, setScriptMode] = useState(workspace?.settings?.scriptPreference ?? "roman");
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef(null);
  const dataKey = useRef(null);

  const load = useCallback(async () => {
    try {
      setMeeting(await api.meetings.get(id));
    } catch (e) {
      if (e?.status === 404) setNotFound(true);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll only the small meeting record; the worker does the processing, not this page.
  useEffect(() => {
    if (meeting?.status !== "processing") return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [meeting?.status, load]);

  // Fetch the transcript once it exists (after assembly), and once more when processing ends.
  useEffect(() => {
    if (!meeting || stageIdx(meeting.stage) < stageIdx("summarise")) return;
    const key = meeting.status === "processing" ? "assembled" : `final:${meeting.updatedAt}`;
    if (dataKey.current === key) return;
    dataKey.current = key;
    api.meetings.data(id).then(setData).catch(() => {});
  }, [meeting, id]);

  const run = async (fn) => {
    setBusy(true);
    setActionError("");
    try {
      const m = await fn();
      if (m) setMeeting(m);
    } catch (e) {
      setActionError(e?.message || "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const retryStage = (stage) => run(() => api.meetings.retry(id, stage));
  const summariseAnyway = () => run(() => api.meetings.summarise(id, true));

  const saveTitle = async () => {
    const value = titleDraft.trim();
    if (!value) return;
    await run(() => api.meetings.rename(id, value));
    setEditingTitle(false);
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await api.meetings.remove(id);
      navigate("/");
    } catch {
      setActionError("Could not delete meeting. Try again.");
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const seekTo = (t) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = t;
    a.play().catch(() => {});
  };

  if (notFound) {
    return (
      <div className="py-20 text-center text-muted-foreground">
        <p className="mb-2">This meeting does not exist.</p>
        <Link to="/" className="text-sm underline">Back to meetings</Link>
      </div>
    );
  }
  if (!meeting) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const cur = stageIdx(meeting.stage);
  const pct = progressPct(meeting);
  const coveragePct = meeting.coverage ? Math.round(meeting.coverage.ratio * 100) : null;
  const processing = meeting.status === "processing";
  const hasTranscript = data?.lines?.length > 0;

  return (
    <div>
      <Link to="/" className="inline-flex items-center text-sm text-muted-foreground mb-3">
        <ArrowLeft className="w-4 h-4 mr-1" /> Meetings
      </Link>
      <div className="flex items-center gap-1.5">
        {editingTitle ? (
          <>
            <Input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveTitle()}
              className="text-2xl font-bold h-auto py-1 max-w-xs"
              autoFocus
            />
            <Button size="icon" variant="ghost" onClick={saveTitle} aria-label="Save title">
              <Check className="w-5 h-5" />
            </Button>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold tracking-tight">{meeting.title}</h1>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Rename"
              onClick={() => {
                setEditingTitle(true);
                setTitleDraft(meeting.title);
              }}
            >
              <Pencil className="w-4 h-4 text-muted-foreground" />
            </Button>
          </>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-5">
        {new Date(meeting.date).toLocaleString()}
        {meeting.durationSec ? ` · ${fmtDuration(meeting.durationSec)}` : ""}
        {coveragePct !== null ? ` · ${coveragePct}% of speech transcribed` : ""}
      </p>

      {meeting.audio?.playbackUrl && (
        <audio
          ref={audioRef}
          src={meeting.audio.playbackUrl}
          controls
          className="w-full mb-6"
          onTimeUpdate={(e) => setCurrentTime(e.target.currentTime)}
        />
      )}

      {processing && (
        <div className="rounded-2xl border border-border bg-card p-5 mb-6">
          <div className="flex items-center gap-3 mb-4 pb-4 border-b border-border">
            <Loader2 className="w-6 h-6 animate-spin text-primary shrink-0" />
            <div className="flex-1">
              <p className="font-semibold">Processing your meeting…</p>
              <p className="text-xs text-muted-foreground">
                Runs on the server. You can close this page and come back.
              </p>
            </div>
            <span className="text-sm font-medium text-muted-foreground tabular-nums">{pct}%</span>
          </div>
          <div className="w-full h-2 bg-secondary rounded-full overflow-hidden mb-4">
            <div className="h-full bg-primary rounded-full transition-all duration-700 ease-out" style={{ width: `${pct}%` }} />
          </div>
          <div className="space-y-3">
            {STEPS.map((step) => {
              const i = stageIdx(step.key);
              const done = cur > i;
              const active = cur === i;
              const Icon = step.icon;
              return (
                <div key={step.key} className="flex items-center gap-3">
                  <div
                    className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                      done ? "bg-emerald-100 text-emerald-600" : active ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
                    }`}
                  >
                    {done ? <Check className="w-4 h-4" /> : active ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
                  </div>
                  <span className={`text-sm ${done || active ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                    {step.label}
                    {step.key === "transcribe" && meeting.progress?.chunksTotal > 0 && (
                      <span className="text-xs text-muted-foreground ml-2 tabular-nums">
                        {meeting.progress.chunksDone}/{meeting.progress.chunksTotal}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {meeting.status === "failed" && meeting.error && (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive space-y-3 mb-6">
          <p>
            Processing stopped during {STAGE_LABEL[meeting.error.stage] ?? meeting.error.stage}. {meeting.error.message}
          </p>
          {meeting.error.retryable && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => retryStage(meeting.error.stage)}>
              <RefreshCw className="w-4 h-4 mr-1" /> Retry {STAGE_LABEL[meeting.error.stage] ?? "stage"}
            </Button>
          )}
        </div>
      )}

      {!processing && meeting.summaryStatus === "skipped_low_coverage" && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 mb-6 space-y-3 text-amber-900">
          <div className="flex gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <p className="text-sm">
              Only {coveragePct ?? 0}% of the speech was transcribed; summary withheld. Check the transcript before relying on it.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy || !hasTranscript} onClick={summariseAnyway}>
              <Sparkles className="w-4 h-4 mr-1" /> Summarise anyway
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => retryStage("transcribe")}>
              <RefreshCw className="w-4 h-4 mr-1" /> Retry failed parts
            </Button>
          </div>
        </div>
      )}

      {!processing && meeting.status === "partial" && meeting.summaryStatus !== "skipped_low_coverage" && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 mb-6 space-y-3 text-amber-900 text-sm">
          <p>Part of this recording could not be transcribed.</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => retryStage("transcribe")}>
            <RefreshCw className="w-4 h-4 mr-1" /> Retry failed parts
          </Button>
        </div>
      )}

      {actionError && <p className="text-sm text-destructive mb-4">{actionError}</p>}

      {meeting.summary && (
        <div className="rounded-2xl border border-border bg-card p-4 mb-6">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-muted-foreground" />
            <h2 className="font-semibold">Summary</h2>
          </div>
          <div className="text-sm leading-relaxed text-muted-foreground meeting-summary">
            <ReactMarkdown
              components={{
                h1: ({ node, ...p }) => <h3 className="text-base font-semibold mt-3 mb-1 text-foreground" {...p} />,
                h2: ({ node, ...p }) => <h3 className="text-base font-semibold mt-3 mb-1 text-foreground" {...p} />,
                h3: ({ node, ...p }) => <h4 className="text-sm font-semibold mt-2 mb-1 text-foreground" {...p} />,
                ul: ({ node, ...p }) => <ul className="list-disc pl-5 space-y-1 my-1" {...p} />,
                ol: ({ node, ...p }) => <ol className="list-decimal pl-5 space-y-1 my-1" {...p} />,
                strong: ({ node, ...p }) => <strong className="font-semibold text-foreground" {...p} />,
              }}
            >
              {meeting.summary}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {!processing && meeting.summaryStatus === "failed" && (
        <div className="rounded-2xl border border-border bg-card p-4 mb-6 text-center">
          <p className="text-sm text-muted-foreground mb-3">
            {meeting.error?.stage === "summarise" ? meeting.error.message : "The summary could not be generated."}
          </p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => retryStage("summarise")}>
            <RefreshCw className="w-4 h-4 mr-1" /> Retry summary
          </Button>
        </div>
      )}

      <ActionItems actionItems={meeting.actionItems} />

      {(hasTranscript || !processing) && (
        <div>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="font-semibold">Transcript</h2>
            <div className="flex items-center gap-2 flex-wrap">
              {hasTranscript && <MeetingExport meeting={meeting} lines={data.lines} scriptMode={scriptMode} />}
              <div className="flex gap-1 bg-secondary rounded-full p-0.5" role="group" aria-label="Script">
                {SCRIPT_MODES.map((s) => (
                  <button
                    key={s.mode}
                    onClick={() => setScriptMode(s.mode)}
                    aria-pressed={scriptMode === s.mode}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                      scriptMode === s.mode ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <TranscriptView lines={data?.lines} currentTime={currentTime} onSeek={seekTo} scriptMode={scriptMode} />
        </div>
      )}

      <div className="mt-8 pt-6 border-t border-border">
        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogTrigger asChild>
            <Button variant="outline" disabled={busy} className="w-full text-destructive border-destructive/30 hover:bg-destructive/5">
              <Trash2 className="w-4 h-4 mr-2" /> Delete meeting
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this meeting?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently removes the recording, transcript, and summary. This can't be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <Button disabled={busy} onClick={doDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {busy ? "Deleting…" : "Delete"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
