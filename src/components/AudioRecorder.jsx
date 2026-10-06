import { useState, useRef, useEffect } from "react";
import { Mic, Pause, Play, Square, Upload, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { saveChunk, setMeta, getMeta, getAllChunks, clearRecording } from "@/lib/recordingStore";

function fmt(s) {
  s = Math.max(0, Math.floor(s));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const MIME = "audio/webm";

// Derive the correct file extension from the actual MediaRecorder mime type.
// Safari/iOS produces audio/mp4 — naming it .webm breaks downstream consumers.
function extForMime(mime) {
  if (!mime) return "webm";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg")) return "mp3";
  return "webm";
}
// Emit a chunk every 2s so the auto-save never lags more than ~2s behind live.
const TIMESLICE = 2000;

export default function AudioRecorder({ onComplete }) {
  // "idle" | "recording" | "paused"
  const [status, setStatus] = useState("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState(null); // { duration, mime } when an interrupted recording was found
  const [savedBytes, setSavedBytes] = useState(0);

  const mrRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]); // in-memory copy (primary source for a normal stop)
  const seqRef = useRef(0);
  const timerRef = useRef(null);
  const accumRef = useRef(0); // active seconds accumulated before the current run
  const runStartRef = useRef(null);
  const wakeLockRef = useRef(null);

  // Recover an interrupted recording (tab killed / memory pressure / lock) on mount.
  useEffect(() => {
    (async () => {
      try {
        const meta = await getMeta();
        if (meta && meta.active && meta.duration > 1) {
          const chunks = await getAllChunks();
          if (chunks.length) setRecovery({ duration: meta.duration, mime: meta.mime });
        }
      } catch {}
    })();
  }, []);

  // Re-acquire the wake lock when the tab becomes visible again (browsers
  // release it while the page is hidden).
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && status === "recording") requestWakeLock();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [status]);

  const startTimer = () => {
    runStartRef.current = Date.now();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setElapsed(accumRef.current + (Date.now() - runStartRef.current) / 1000);
    }, 250);
  };
  const stopTimer = () => {
    if (runStartRef.current) {
      accumRef.current += (Date.now() - runStartRef.current) / 1000;
      runStartRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const requestWakeLock = async () => {
    try {
      if (navigator.wakeLock?.request) {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
        wakeLockRef.current?.addEventListener?.("release", () => {
          wakeLockRef.current = null;
        });
      }
    } catch {}
  };
  const releaseWakeLock = async () => {
    try {
      await wakeLockRef.current?.release();
    } catch {}
    wakeLockRef.current = null;
  };

  const persistMeta = async (active) => {
    const duration =
      accumRef.current + (runStartRef.current ? (Date.now() - runStartRef.current) / 1000 : 0);
    try {
      await setMeta({ id: "current", active, duration, ts: Date.now(), mime: mrRef.current?.mimeType || MIME });
    } catch {}
  };

  const beginRecording = async () => {
    setError("");
    try {
      await clearRecording(); // clear any stale data before a fresh session
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream);
      const mime = mr.mimeType || MIME;
      mrRef.current = mr;
      chunksRef.current = [];
      seqRef.current = 0;
      accumRef.current = 0;
      setSavedBytes(0);

      mr.ondataavailable = async (e) => {
        if (e.data && e.data.size) {
          const seq = seqRef.current++;
          chunksRef.current.push(e.data);
          try {
            await saveChunk(e.data, seq); // durable copy for crash recovery
            setSavedBytes((b) => b + e.data.size);
          } catch {}
        }
      };
      mr.onstop = async () => {
        stopTimer();
        streamRef.current?.getTracks().forEach((t) => t.stop());
        await releaseWakeLock();
        const blob = new Blob(chunksRef.current, { type: mime });
        await clearRecording();
        setStatus("idle");
        setElapsed(0);
        setSavedBytes(0);
        if (blob.size) {
          onComplete(new File([blob], `recording-${Date.now()}.${extForMime(mime)}`, { type: blob.type }));
        }
      };
      mr.onerror = () => {
        try {
          mr.stop();
        } catch {}
      };

      mr.start(TIMESLICE);
      setStatus("recording");
      setElapsed(0);
      startTimer();
      await requestWakeLock();
      await persistMeta(true);
    } catch (e) {
      setError("Could not access microphone. Try uploading a file instead.");
    }
  };

  const pauseRecording = () => {
    const mr = mrRef.current;
    if (mr && mr.state === "recording") {
      try {
        mr.pause();
      } catch {}
      stopTimer();
      setStatus("paused");
      persistMeta(true);
      releaseWakeLock();
    }
  };

  const resumeRecording = () => {
    const mr = mrRef.current;
    if (mr && mr.state === "paused") {
      try {
        mr.resume();
      } catch {}
      setStatus("recording");
      startTimer();
      requestWakeLock();
      persistMeta(true);
    }
  };

  const stopRecording = () => {
    const mr = mrRef.current;
    if (mr && mr.state !== "inactive") {
      try {
        mr.requestData?.(); // flush the current chunk immediately
      } catch {}
      try {
        mr.stop();
      } catch {}
    }
  };

  // Turn the chunks captured before a crash into a file, without recording more.
  const recoverRecording = async () => {
    try {
      const chunks = await getAllChunks();
      chunks.sort((a, b) => a.seq - b.seq);
      if (chunks.length) {
        const recoverMime = recovery?.mime || MIME;
        const blob = new Blob(chunks.map((c) => c.blob), { type: recoverMime });
        await clearRecording();
        onComplete(new File([blob], `recording-recovered-${Date.now()}.${extForMime(recoverMime)}`, { type: blob.type }));
      } else {
        setRecovery(null);
      }
    } catch {
      setError("Could not recover the previous recording.");
      setRecovery(null);
    }
  };

  const discardRecovery = async () => {
    await clearRecording();
    setRecovery(null);
  };

  const onFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) onComplete(file);
  };

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error}</p>}

      {recovery && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            <p className="text-sm font-medium text-amber-800">
              A recording was interrupted ({fmt(recovery.duration)}). Keep what was captured?
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={recoverRecording} className="flex-1 rounded-full">
              Keep recording
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={discardRecovery}
              className="flex-1 rounded-full"
            >
              Discard
            </Button>
          </div>
        </div>
      )}

      {!recovery && status === "idle" && (
        <div className="flex flex-col gap-3">
          <Button onClick={beginRecording} className="w-full h-14 text-base rounded-full">
            <Mic className="w-5 h-5 mr-2" /> Start recording
          </Button>
          <label className="w-full">
            <input type="file" accept="audio/*,video/*" className="hidden" onChange={onFileChange} />
            <span className="flex items-center justify-center h-14 w-full rounded-full border border-input bg-secondary text-secondary-foreground cursor-pointer text-base">
              <Upload className="w-5 h-5 mr-2" /> Upload audio file
            </span>
          </label>
        </div>
      )}

      {!recovery && status !== "idle" && (
        <div className="rounded-2xl border border-border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {status === "recording" ? (
                <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
              ) : (
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
              )}
              <span className="font-medium">
                {status === "recording" ? "Recording" : "Paused"}
              </span>
            </div>
            <span className="text-2xl font-mono tabular-nums">{fmt(elapsed)}</span>
          </div>
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            Auto-saving — safe if the screen locks or the app closes
          </p>
          <div className="flex gap-2">
            {status === "recording" ? (
              <Button
                onClick={pauseRecording}
                variant="outline"
                className="flex-1 h-12 rounded-full"
              >
                <Pause className="w-4 h-4 mr-2" /> Pause
              </Button>
            ) : (
              <Button onClick={resumeRecording} className="flex-1 h-12 rounded-full">
                <Play className="w-4 h-4 mr-2" /> Resume
              </Button>
            )}
            <Button
              onClick={stopRecording}
              variant="destructive"
              className="flex-1 h-12 rounded-full"
            >
              <Square className="w-4 h-4 mr-2" /> Stop &amp; save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}