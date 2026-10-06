import { useState, useRef, useEffect } from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";

function fmt(s) {
  s = Math.max(0, Math.floor(s));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// Record ~60s for a richer sample; server trims to 30s for pyannote.
const TARGET = 58;
const MIN_STOP = 20;

const SAMPLE_LINES = {
  en: "Hello, my name is [your name]. I'm recording this so MeetingID can recognize my voice. In our meetings we discuss project updates, review tasks, and plan next steps. Please speak naturally and clearly.",
  hi: "नमस्ते, मेरा नाम [आपका नाम] है। मैं यह रिकॉर्ड कर रहा हूं ताकि MeetingID मेरी आवाज पहचान सके। हमारी बैठकों में हम प्रोजेक्ट अपडेट्स और अगले कदमों पर चर्चा करते हैं।",
  gu: "નમસ્તે, મારું નામ [તમારું નામ] છે. હું આ રેકોર્ડ કરી રહ્યો છું જેથી MeetingID મારો અવાજ ઓળખી શકે. અમારી બેઠકોમાં અમે પ્રોજેક્ટ અપડેટ્સ અને આગળના પગલાં પર ચર્ચા કરીએ છીએ.",
};

export default function EnrollmentRecorder({ onComplete }) {
  const [status, setStatus] = useState("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [lang, setLang] = useState("en");

  const mrRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const startTsRef = useRef(null);
  const wakeLockRef = useRef(null);

  const stopTimer = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };
  const requestWakeLock = async () => {
    try { if (navigator.wakeLock?.request) wakeLockRef.current = await navigator.wakeLock.request("screen"); } catch {}
  };
  const releaseWakeLock = async () => {
    try { await wakeLockRef.current?.release(); } catch {}
    wakeLockRef.current = null;
  };

  useEffect(() => {
    return () => {
      stopTimer();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      releaseWakeLock();
    };
  }, []);

  const stop = () => {
    const mr = mrRef.current;
    if (mr && mr.state !== "inactive") {
      try { mr.requestData?.(); } catch {}
      try { mr.stop(); } catch {}
    }
  };

  useEffect(() => {
    if (status === "recording" && elapsed >= TARGET) stop();
  }, [elapsed, status]);

  const start = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream);
      const mime = mr.mimeType || "audio/webm";
      mrRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        stopTimer();
        streamRef.current?.getTracks().forEach((t) => t.stop());
        releaseWakeLock();
        const blob = new Blob(chunksRef.current, { type: mime });
        if (blob.size) {
          const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : "webm";
          onComplete(new File([blob], `enroll-${Date.now()}.${ext}`, { type: blob.type }));
        } else {
          setStatus("idle");
          setError("No audio captured. Try again.");
        }
      };
      mr.start(1000);
      setStatus("recording");
      setElapsed(0);
      startTsRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed((Date.now() - startTsRef.current) / 1000);
      }, 250);
      requestWakeLock();
    } catch {
      setError("Could not access microphone. Please allow mic access and try again.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {Object.entries(SAMPLE_LINES).map(([code, _]) => (
          <button
            key={code}
            type="button"
            onClick={() => setLang(code)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              lang === code ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"
            }`}
          >
            {code === "en" ? "English" : code === "hi" ? "हिंदी" : "ગુજરાતી"}
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-border bg-secondary/50 p-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Read this aloud</p>
        <p className="text-sm leading-relaxed">{SAMPLE_LINES[lang]}</p>
        <p className="text-xs text-muted-foreground mt-2">
          Read naturally, then repeat until you reach about 60 seconds.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {status === "idle" && (
        <Button onClick={start} className="w-full h-14 text-base rounded-full">
          <Mic className="w-5 h-5 mr-2" /> Start recording
        </Button>
      )}

      {status === "recording" && (
        <div className="rounded-2xl border border-border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 font-medium">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" /> Recording
            </span>
            <span className="text-2xl font-mono tabular-nums">{fmt(elapsed)} / 0:58</span>
          </div>
          <div className="h-2 rounded-full bg-secondary overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, (elapsed / TARGET) * 100)}%` }} />
          </div>
          <Button onClick={stop} variant="destructive" disabled={elapsed < MIN_STOP} className="w-full h-12 rounded-full">
            <Square className="w-4 h-4 mr-2" />
            {elapsed < MIN_STOP ? `Stop & save (wait ${MIN_STOP - Math.floor(elapsed)}s)` : "Stop & save"}
          </Button>
        </div>
      )}
    </div>
  );
}