import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import AudioRecorder from "@/components/AudioRecorder";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2, Check } from "lucide-react";
import { getUploadSignature, uploadToCloudinary, readMediaDuration, validateAudioFile } from "@/lib/cloudinaryUpload";

function fmtDuration(s) {
  if (!s || s < 0) return "";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  if (m > 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m ${sec}s`;
}

export default function Record() {
  const [title, setTitle] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [file, setFile] = useState(null);
  const [duration, setDuration] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadMb, setUploadMb] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [keyTerms, setKeyTerms] = useState("");
  const [speakers, setSpeakers] = useState([]);
  const [expectedSpeakers, setExpectedSpeakers] = useState([]);
  const [durationWarning, setDurationWarning] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    base44.entities.Speaker.list("-created_date", 100).then((list) => {
      setSpeakers(list.filter((s) => s.voiceprint_id));
    }).catch(() => {});
  }, []);

  // When a file is selected (from recorder or upload), validate and read duration.
  const handleAudioReady = async (f) => {
    const verr = validateAudioFile(f);
    if (verr) { setError(verr); return; }
    setError("");
    setFile(f);
    setAudioUrl(URL.createObjectURL(f));
    const d = await readMediaDuration(f);
    setDuration(d);
    if (d === null) {
      setError("This file has no playable audio.");
    } else if (d < 1) {
      setError("This file has no playable audio.");
    } else if (d > 3 * 3600) {
      setDurationWarning("This recording is very long — processing may take several minutes.");
    } else {
      setDurationWarning("");
    }
  };

  const toggleSpeaker = (id) => {
    setExpectedSpeakers((prev) => {
      if (prev.includes(id)) return prev.filter((s) => s !== id);
      if (prev.length >= 10) return prev; // max 10
      return [...prev, id];
    });
  };

  const handleCreate = async () => {
    setError("");
    if (!file) { setError("Record or upload audio first."); return; }
    setCreating(true);
    try {
      // 1. Get upload signature
      const sig = await getUploadSignature();
      // 2. Upload directly to Cloudinary with progress
      setUploading(true);
      const uploaded = await uploadToCloudinary(file, sig, (pct, loaded) => {
        setUploadPct(pct);
        setUploadMb(loaded / (1024 * 1024));
      });
      setUploading(false);

      // 3. Create the meeting record
      const meeting = await base44.entities.Meeting.create({
        title: title.trim() || `Meeting ${new Date().toLocaleDateString()}`,
        date: new Date().toISOString(),
        audio_file_url: uploaded.url,
        cloudinary_public_id: uploaded.publicId,
        duration_seconds: duration || (uploaded.duration ? uploaded.duration : 0),
        status: "processing",
        stage: "uploaded",
        stage_detail: null,
        language_mode: [],
        engine: "deepgram",
        key_terms: keyTerms.split(",").map((t) => t.trim()).filter(Boolean),
        expected_speaker_ids: expectedSpeakers,
        processing_started_at: new Date().toISOString(),
        summary_status: "pending",
        transcript: [],
        action_items: [],
        unknown_segment_count: 0,
        participants: [],
        raw_utterances: [],
        error_message: "",
      });

      // 4. Fire the first stage of the staged pipeline
      base44.functions.invoke("processMeeting", { meeting_id: meeting.id }).catch(() => {});
      navigate(`/meetings/${meeting.id}`);
    } catch (e) {
      setError(e?.message || "Could not create meeting. Try again.");
      setUploading(false);
      setCreating(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-6">New meeting</h1>
      <div className="space-y-5">
        <div>
          <label className="text-sm font-medium mb-1.5 block">Title (optional)</label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Weekly sync" />
        </div>

        <div>
          <label className="text-sm font-medium mb-1.5 block">Names &amp; terms (optional)</label>
          <Input
            value={keyTerms}
            onChange={(e) => setKeyTerms(e.target.value)}
            placeholder="e.g. Q4 targets, Tempsens, KOC"
          />
          <p className="text-xs text-muted-foreground mt-1">Comma-separated. Helps the engine spell names correctly.</p>
        </div>

        {speakers.length > 0 && (
          <div>
            <label className="text-sm font-medium mb-2 block">Expected participants (optional, max 10)</label>
            <div className="flex flex-wrap gap-2">
              {speakers.slice(0, 15).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleSpeaker(s.id)}
                  className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                    expectedSpeakers.includes(s.id)
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                  }`}
                >
                  {expectedSpeakers.includes(s.id) && <Check className="w-3 h-3 inline mr-1" />}
                  {s.name}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Most recently enrolled first. Speeds up speaker identification.</p>
          </div>
        )}

        <div>
          <label className="text-sm font-medium mb-2 block">Audio</label>
          {audioUrl ? (
            <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
              <audio src={audioUrl} controls className="w-full" />
              {duration && (
                <p className="text-xs text-muted-foreground">Duration: {fmtDuration(duration)}</p>
              )}
              {durationWarning && (
                <p className="text-xs text-amber-600">{durationWarning}</p>
              )}
              <Button
                variant="outline"
                className="w-full rounded-full"
                onClick={() => { setAudioUrl(""); setFile(null); setDuration(null); setDurationWarning(""); }}
              >
                Use different audio
              </Button>
            </div>
          ) : (
            <AudioRecorder onComplete={handleAudioReady} />
          )}
        </div>

        {creating ? (
          <div className="rounded-2xl border border-border bg-card p-6 space-y-4 animate-in fade-in duration-300">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0" />
              <span className="font-medium">
                {uploading ? "Uploading audio…" : "Preparing your meeting…"}
              </span>
            </div>
            {uploading ? (
              <div className="space-y-2">
                <div className="h-2.5 rounded-full bg-secondary overflow-hidden">
                  <div className="h-full bg-primary transition-all duration-300" style={{ width: `${uploadPct}%` }} />
                </div>
                <p className="text-xs text-muted-foreground text-right">{uploadPct}% · {uploadMb.toFixed(1)} MB</p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                This usually takes a few seconds. You'll be taken to the meeting page automatically.
              </p>
            )}
          </div>
        ) : (
          <>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              onClick={handleCreate}
              disabled={!file}
              className="w-full h-12 rounded-full text-base"
            >
              Process meeting
            </Button>
          </>
        )}
      </div>
    </div>
  );
}