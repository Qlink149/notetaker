import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import ReactMarkdown from "react-markdown";
import TranscriptView from "@/components/TranscriptView";
import ActionItems from "@/components/ActionItems";
import MeetingExport from "@/components/MeetingExport";
import {
  Loader2, ArrowLeft, AlertCircle, Sparkles, Pencil, Check,
  RefreshCw, Trash2, Upload, FileText, Users, GitMerge, Clock, Languages,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { getMeetingAudioUrl, deleteMeetingAudio } from "@/lib/audioStore";

const STAGE_ORDER = ["uploaded", "transcribing", "diarizing", "aligning", "romanizing", "summarizing", "completed"];
const STAGE_STEPS = [
  { key: "uploaded", label: "Uploaded", icon: Upload },
  { key: "transcribing", label: "Transcribing", icon: FileText },
  { key: "diarizing", label: "Identifying speakers", icon: Users },
  { key: "aligning", label: "Aligning", icon: GitMerge },
  { key: "romanizing", label: "Romanizing", icon: Languages },
  { key: "summarizing", label: "Summarizing", icon: Sparkles },
];

function stageIndex(stage) {
  const idx = STAGE_ORDER.indexOf(stage);
  return idx < 0 ? 0 : idx;
}

export default function MeetingDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [meeting, setMeeting] = useState(null);
  const [speakers, setSpeakers] = useState([]);
  const [relabelTarget, setRelabelTarget] = useState(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [audioBlobUrl, setAudioBlobUrl] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scriptMode, setScriptMode] = useState("romanized");
  const audioRef = useRef(null);
  const [currentTime, setCurrentTime] = useState(0);

  const load = useCallback(async () => {
    try { setMeeting(await base44.entities.Meeting.get(id)); } catch { setMeeting(null); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Re-invoke processMeeting every 4s while processing, then reload.
  // The staged function does one stage per invocation; this advances it.
  // Auto-recovery: if a function timed out mid-stage, the lock stays at
  // "processing" and the server won't retry until its own lock expires.
  // We clear stuck locks from the client after 3 min (longer than the 120s
  // max server lock) so the next poll forces a retry — the user never has
  // to click anything.
  const meetingRef = useRef(null);
  meetingRef.current = meeting;
  useEffect(() => {
    if (!meeting || meeting.status !== "processing") return;
    const t = setInterval(async () => {
      const m = meetingRef.current;
      if (m?.stage_detail === "processing" && m?.updated_date) {
        const ageMs = Date.now() - new Date(m.updated_date).getTime();
        if (ageMs > 3 * 60 * 1000) {
          await base44.entities.Meeting.update(id, { stage_detail: null }).catch(() => {});
        }
      }
      await base44.functions.invoke("processMeeting", { meeting_id: id }).catch(() => {});
      load();
    }, 4000);
    return () => clearInterval(t);
  }, [meeting?.status, id, load]);

  useEffect(() => {
    base44.entities.Speaker.list("-created_date", 100).then(setSpeakers).catch(() => {});
  }, []);

  useEffect(() => { getMeetingAudioUrl(id).then(setAudioBlobUrl); }, [id]);

  const unknowns = meeting?.transcript
    ? Array.from(new Set(meeting.transcript.filter((t) => t.speaker_name.startsWith("Unknown")).map((t) => t.speaker_name)))
    : [];
  const unknownSpoken = {};
  if (meeting?.transcript) {
    meeting.transcript.filter((t) => t.speaker_name.startsWith("Unknown")).forEach((t) => {
      (unknownSpoken[t.speaker_name] ||= []).push(t.text);
    });
  }

  const httpAudioUrl = meeting?.audio_file_url && /^https?:\/\//.test(meeting.audio_file_url) ? meeting.audio_file_url : null;
  const playableUrl = httpAudioUrl || audioBlobUrl;

  const seekTo = (t) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = t;
    a.play().catch(() => {});
  };

  const refreshSpeakers = () => base44.entities.Speaker.list("-created_date", 100).then(setSpeakers).catch(() => {});

  const doRelabel = async (target, { speaker_id }) => {
    setBusy(true);
    try {
      await base44.functions.invoke("relabelUnknownSpeaker", { meeting_id: id, target_name: target, speaker_id });
      setRelabelTarget(null); setNewName("");
      await load(); refreshSpeakers();
    } catch { alert("Could not relabel. Try again."); }
    finally { setBusy(false); }
  };

  const enrollAndRelabel = async (target) => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      // The server creates a voiceprint from the speaker's audio segments in
      // this meeting — no separate onboarding needed.
      const resp = await base44.functions.invoke("relabelUnknownSpeaker", {
        meeting_id: id, target_name: target, new_name: name,
      });
      setRelabelTarget(null); setNewName("");
      await load(); refreshSpeakers();
      if (resp?.data?.voiceprint_created === false && resp?.data?.voiceprint_error) {
        alert(`Saved, but voiceprint enrollment failed: ${resp.data.voiceprint_error}`);
      }
    } catch { alert("Could not relabel. Try again."); }
    finally { setBusy(false); }
  };

  const reprocess = async () => {
    setBusy(true);
    try {
      // Resume from the current stage instead of restarting from scratch —
      // preserves transcript, raw_utterances, and identification so a 68-min
      // file doesn't need to be re-transcribed after a stall.
      const resumeStage = meeting.stage && meeting.stage !== "failed" ? meeting.stage : "uploaded";
      await base44.entities.Meeting.update(id, {
        status: "processing", stage: resumeStage, stage_detail: null,
        error_message: "",
      });
      setMeeting((m) => m ? { ...m, status: "processing", stage: resumeStage, stage_detail: null, error_message: "" } : m);
      base44.functions.invoke("processMeeting", { meeting_id: id }).catch(() => {});
    } finally { setBusy(false); }
  };

  const regenerateSummary = async () => {
    setBusy(true);
    try {
      await base44.entities.Meeting.update(id, {
        status: "processing", stage: "summarizing", stage_detail: null,
        summary_status: "pending",
      });
      setMeeting((m) => m ? { ...m, status: "processing", stage: "summarizing" } : m);
      base44.functions.invoke("processMeeting", { meeting_id: id }).catch(() => {});
    } finally { setBusy(false); }
  };

  const saveTitle = async () => {
    const value = titleDraft.trim();
    if (!value) return;
    try {
      await base44.entities.Meeting.update(id, { title: value });
      setMeeting((m) => (m ? { ...m, title: value } : m));
      setEditingTitle(false);
    } catch { alert("Could not save title."); }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await base44.entities.Meeting.delete(id);
      await deleteMeetingAudio(id);
      navigate("/");
    } catch { alert("Could not delete meeting. Try again."); }
    finally { setBusy(false); setConfirmDelete(false); }
  };

  if (!meeting) return (
    <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
  );

  const curIdx = stageIndex(meeting.stage);

  return (
    <div>
      <Link to="/" className="inline-flex items-center text-sm text-muted-foreground mb-3">
        <ArrowLeft className="w-4 h-4 mr-1" /> Meetings
      </Link>
      <div className="flex items-center gap-1.5">
        {editingTitle ? (
          <>
            <Input value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveTitle()}
              className="text-2xl font-bold h-auto py-1 max-w-xs" autoFocus />
            <Button size="icon" variant="ghost" onClick={saveTitle}><Check className="w-5 h-5" /></Button>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold tracking-tight">{meeting.title}</h1>
            {meeting.status !== "processing" && (
              <Button size="icon" variant="ghost" onClick={() => { setEditingTitle(true); setTitleDraft(meeting.title); }}>
                <Pencil className="w-4 h-4 text-muted-foreground" />
              </Button>
            )}
          </>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-5">
        {new Date(meeting.date || meeting.created_date).toLocaleString()}
        {meeting.duration_seconds > 0 && ` · ${Math.round(meeting.duration_seconds / 60)} min`}
      </p>

      {playableUrl && (
        <audio ref={audioRef} src={playableUrl} controls className="w-full mb-6"
          onTimeUpdate={(e) => setCurrentTime(e.target.currentTime)} />
      )}

      {meeting.status === "processing" && (
        <div className="rounded-2xl border border-border bg-card p-5 mb-6">
          <div className="flex items-center gap-3 mb-4 pb-4 border-b border-border">
            <Loader2 className="w-6 h-6 animate-spin text-primary shrink-0" />
            <div className="flex-1">
              <p className="font-semibold">Processing your meeting…</p>
              <p className="text-xs text-muted-foreground">Usually about 1 minute per 10 minutes of audio. You can leave this page.</p>
            </div>
            <span className="text-sm font-medium text-muted-foreground tabular-nums">
              {Math.round((curIdx / (STAGE_ORDER.length - 1)) * 100)}%
            </span>
          </div>
          <div className="w-full h-2 bg-secondary rounded-full overflow-hidden mb-4">
            <div
              className="h-full bg-primary rounded-full transition-all duration-700 ease-out"
              style={{ width: `${(curIdx / (STAGE_ORDER.length - 1)) * 100}%` }}
            />
          </div>
          <div className="space-y-3">
            {STAGE_STEPS.map((step, i) => {
              const stepIdx = stageIndex(step.key);
              const isDone = curIdx > stepIdx;
              const isActive = curIdx === stepIdx;
              const Icon = step.icon;
              return (
                <div key={step.key} className="flex items-center gap-3">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                    isDone ? "bg-emerald-100 text-emerald-600" : isActive ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
                  }`}>
                    {isDone ? <Check className="w-4 h-4" /> : isActive ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
                  </div>
                  <span className={`text-sm ${isDone || isActive ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                    {step.label}
                    {isActive && meeting.stage_detail && meeting.stage_detail !== "processing" && meeting.stage_detail !== "waiting for speaker identification" && (
                      <span className="text-xs text-muted-foreground ml-2">{meeting.stage_detail}</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {meeting.status === "completed" && (
        <>
          {unknowns.length > 0 && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 mb-6">
              <div className="flex items-center gap-2 mb-3">
                <AlertCircle className="w-4 h-4 text-amber-600" />
                <p className="text-sm font-medium text-amber-800">
                  {unknowns.length} unidentified voice{unknowns.length > 1 ? "s" : ""} detected — tap to name {unknowns.length > 1 ? "them" : "it"}
                </p>
              </div>
              <div className="space-y-2">
                {unknowns.map((u) => (
                  <div key={u} className="rounded-xl bg-white border border-amber-200 p-3">
                    <p className="text-sm font-medium mb-1">{u}</p>
                    {(unknownSpoken[u] || []).length > 0 && (
                      <p className="text-xs text-muted-foreground italic mb-2 line-clamp-3">"{(unknownSpoken[u] || []).join(" ")}"</p>
                    )}
                    {relabelTarget !== u ? (
                      <Button size="sm" variant="outline" onClick={() => setRelabelTarget(u)}>Name this speaker</Button>
                    ) : (
                      <div className="space-y-2">
                        {speakers.filter((s) => s.voiceprint_id).length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {speakers.filter((s) => s.voiceprint_id).map((s) => (
                              <Button key={s.id} size="sm" variant="secondary" disabled={busy} onClick={() => doRelabel(u, { speaker_id: s.id })}>{s.name}</Button>
                            ))}
                          </div>
                        )}
                        <p className="text-xs text-amber-700">New name? We'll auto-enroll a voiceprint from this voice.</p>
                        <div className="flex gap-2">
                          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Enter a new name" />
                          <Button size="sm" disabled={busy || !newName.trim()} onClick={() => enrollAndRelabel(u)}>Enroll &amp; save</Button>
                          <Button size="sm" variant="ghost" onClick={() => { setRelabelTarget(null); setNewName(""); }}>Cancel</Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {meeting.summary && (
            <div className="rounded-2xl border border-border bg-card p-4 mb-6">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-semibold">Summary</h2>
              </div>
              <div className="text-sm leading-relaxed text-muted-foreground meeting-summary">
                <ReactMarkdown components={{
                  h1: ({ node, ...p }) => <h3 className="text-base font-semibold mt-3 mb-1 text-foreground" {...p} />,
                  h2: ({ node, ...p }) => <h3 className="text-base font-semibold mt-3 mb-1 text-foreground" {...p} />,
                  h3: ({ node, ...p }) => <h4 className="text-sm font-semibold mt-2 mb-1 text-foreground" {...p} />,
                  ul: ({ node, ...p }) => <ul className="list-disc pl-5 space-y-1 my-1" {...p} />,
                  ol: ({ node, ...p }) => <ol className="list-decimal pl-5 space-y-1 my-1" {...p} />,
                  strong: ({ node, ...p }) => <strong className="font-semibold text-foreground" {...p} />,
                }}>{meeting.summary}</ReactMarkdown>
              </div>
            </div>
          )}

          {meeting.summary_status === "failed" && (
            <div className="rounded-2xl border border-border bg-card p-4 mb-6 text-center">
              <p className="text-sm text-muted-foreground mb-3">Summary generation failed.</p>
              <Button size="sm" variant="outline" disabled={busy} onClick={regenerateSummary}>
                <RefreshCw className="w-4 h-4 mr-1" /> Regenerate summary
              </Button>
            </div>
          )}

          <ActionItems actionItems={meeting.action_items} />

          <div>
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h2 className="font-semibold">Transcript</h2>
              <div className="flex items-center gap-2 flex-wrap">
                <MeetingExport meeting={meeting} />
                <div className="flex gap-1 bg-secondary rounded-full p-0.5">
                  {[
                    { mode: "romanized", label: "Romanized" },
                    { mode: "native", label: "Original" },
                    { mode: "both", label: "Both" },
                  ].map((s) => (
                    <button
                      key={s.mode}
                      onClick={() => setScriptMode(s.mode)}
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
            <TranscriptView transcript={meeting.transcript} currentTime={currentTime} onSeek={seekTo} scriptMode={scriptMode} />
          </div>
        </>
      )}

      {meeting.status === "failed" && (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive space-y-3">
          <p>Processing failed. {meeting.error_message || "Please try again."}</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={reprocess}>
            <RefreshCw className="w-4 h-4 mr-1" /> Reprocess
          </Button>
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
              <AlertDialogDescription>This permanently removes the recording, transcript, and summary. This can't be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <Button disabled={busy} onClick={doDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}{busy ? "Deleting…" : "Delete"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}