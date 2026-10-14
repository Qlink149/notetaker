import { useState, useRef, useEffect } from 'react';
import { Mic, Pause, Play, Square, Upload, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { saveChunk, setMeta, getMeta, getAllChunks, clearRecording } from '@/lib/recordingStore';
import { createSilenceWatch, rmsDb } from '@/lib/micWatch';
import { useLeaveWarning } from '@/lib/useLeaveWarning';
import { AUDIO_ACCEPT } from '@/lib/cloudinaryUpload';

function fmt(s) {
  s = Math.max(0, Math.floor(s));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const MIME = 'audio/webm';

// Derive the correct file extension from the actual MediaRecorder mime type.
// Safari/iOS produces audio/mp4 — naming it .webm breaks downstream consumers.
function extForMime(mime) {
  if (!mime) return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg')) return 'mp3';
  return 'webm';
}
// Emit a chunk every 2s so the auto-save never lags more than ~2s behind live.
const TIMESLICE = 2000;
// While recording, the saved copy is stamped this often. A stamp newer than FRESH_MS means another tab on this
// device is recording right now, not that a recording was interrupted.
const STAMP_MS = 10_000;
const FRESH_MS = 30_000;

/**
 * onComplete(file, info): `file.recorded` is true for audio made here, which the page keeps a saved copy of until
 * the upload is confirmed (clearRecording). `info.stoppedEarly` means the recording ended without the person
 * pressing Stop (the microphone was taken away); `info.seconds` is how much was captured.
 */
export default function AudioRecorder({ onComplete }) {
  // "idle" | "recording" | "paused"
  const [status, setStatus] = useState('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  // { duration, mime, pending } when a saved recording was found: interrupted, or finished but never uploaded
  const [recovery, setRecovery] = useState(null);
  const [savedBytes, setSavedBytes] = useState(0);
  const [level, setLevel] = useState(-100);
  const [silent, setSilent] = useState(false);
  const [muted, setMuted] = useState(false);

  const mrRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]); // in-memory copy (primary source for a normal stop)
  const seqRef = useRef(0);
  const timerRef = useRef(null);
  const stampRef = useRef(null);
  const watchRef = useRef(null);
  const accumRef = useRef(0); // active seconds accumulated before the current run
  const runStartRef = useRef(null);
  const wakeLockRef = useRef(null);
  const statusRef = useRef('idle');
  const userStopRef = useRef(false);
  statusRef.current = status;

  // Leaving the page while recording would lose what is not saved yet: ask first.
  useLeaveWarning(status !== 'idle');

  // Find a saved recording on mount: interrupted (tab killed / memory pressure / lock), or finished but never
  // uploaded. A stamp from the last seconds means another tab is recording right now, so nothing to recover.
  useEffect(() => {
    (async () => {
      try {
        const meta = await getMeta();
        if (meta && (meta.active || meta.pending) && meta.duration > 1) {
          if (meta.active && Date.now() - (meta.ts || 0) < FRESH_MS) return;
          const chunks = await getAllChunks();
          if (chunks.length)
            setRecovery({
              duration: meta.duration,
              mime: meta.mime,
              pending: Boolean(!meta.active && meta.pending),
            });
        }
      } catch {}
    })();
  }, []);

  // Re-acquire the wake lock when the tab becomes visible again (browsers
  // release it while the page is hidden).
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && status === 'recording') requestWakeLock();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [status]);

  // Release the microphone and timers if the page is left mid-recording.
  useEffect(
    () => () => {
      stopMicWatch();
      if (stampRef.current) clearInterval(stampRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    },
    [],
  );

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

  // Listens to the microphone's own level so a dead or covered microphone is noticed while there is still time.
  const startMicWatch = (stream) => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      ctx.resume?.().catch?.(() => {});
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(analyser); // not connected to the speakers
      const buf = new Float32Array(analyser.fftSize);
      const watch = createSilenceWatch();
      const timer = setInterval(() => {
        if (statusRef.current !== 'recording') {
          watch.reset();
          setSilent(false);
          return;
        }
        analyser.getFloatTimeDomainData(buf);
        const db = rmsDb(buf);
        setLevel(db);
        setSilent(watch.update(db, Date.now()));
      }, 500);
      watchRef.current = { ctx, timer };
    } catch {
      /* the level meter is a help, never a requirement */
    }
  };
  const stopMicWatch = () => {
    const w = watchRef.current;
    watchRef.current = null;
    if (!w) return;
    clearInterval(w.timer);
    w.ctx.close?.().catch?.(() => {});
  };

  const requestWakeLock = async () => {
    try {
      if (navigator.wakeLock?.request) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        wakeLockRef.current?.addEventListener?.('release', () => {
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

  const currentSeconds = () =>
    accumRef.current + (runStartRef.current ? (Date.now() - runStartRef.current) / 1000 : 0);

  const persistMeta = async (active, pending = false) => {
    try {
      await setMeta({
        id: 'current',
        active,
        pending,
        duration: currentSeconds(),
        ts: Date.now(),
        mime: mrRef.current?.mimeType || MIME,
      });
    } catch {}
  };

  const beginRecording = async () => {
    setError('');
    try {
      // another tab of this app on this device is recording right now: starting here would wipe its saved copy
      const meta = await getMeta().catch(() => null);
      if (meta?.active && Date.now() - (meta.ts || 0) < FRESH_MS) {
        setError('A recording is already running in another tab on this device. Stop it first.');
        return;
      }
      await clearRecording(); // clear any stale data before a fresh session
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream);
      const mime = mr.mimeType || MIME;
      mrRef.current = mr;
      chunksRef.current = [];
      seqRef.current = 0;
      accumRef.current = 0;
      userStopRef.current = false;
      setSavedBytes(0);
      setSilent(false);
      setMuted(false);
      // a call or another app taking the microphone shows up as the track going quiet or ending
      stream.getTracks().forEach((t) => {
        t.onmute = () => setMuted(true);
        t.onunmute = () => setMuted(false);
      });

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
        const seconds = currentSeconds();
        stopTimer();
        stopMicWatch();
        if (stampRef.current) clearInterval(stampRef.current);
        stampRef.current = null;
        streamRef.current?.getTracks().forEach((t) => t.stop());
        await releaseWakeLock();
        const blob = new Blob(chunksRef.current, { type: mime });
        const stoppedEarly = !userStopRef.current;
        // The saved copy stays until the page confirms the upload: between Stop and a finished upload it is the
        // only copy that survives a closed tab, a reload or a failed connection.
        if (blob.size) await persistMeta(false, true);
        else await clearRecording();
        setStatus('idle');
        setElapsed(0);
        setSavedBytes(0);
        setSilent(false);
        setMuted(false);
        if (blob.size) {
          const file = new File([blob], `recording-${Date.now()}.${extForMime(mime)}`, {
            type: blob.type,
          });
          file.recorded = true;
          onComplete(file, { stoppedEarly, seconds });
        }
      };
      mr.onerror = () => {
        try {
          mr.stop();
        } catch {}
      };

      mr.start(TIMESLICE);
      setStatus('recording');
      setElapsed(0);
      startTimer();
      startMicWatch(stream);
      await requestWakeLock();
      await persistMeta(true);
      stampRef.current = setInterval(() => persistMeta(true), STAMP_MS);
    } catch (e) {
      setError('Could not access microphone. Try uploading a file instead.');
    }
  };

  const pauseRecording = () => {
    const mr = mrRef.current;
    if (mr && mr.state === 'recording') {
      try {
        mr.pause();
      } catch {}
      stopTimer();
      setStatus('paused');
      persistMeta(true);
      releaseWakeLock();
    }
  };

  const resumeRecording = () => {
    const mr = mrRef.current;
    if (mr && mr.state === 'paused') {
      try {
        mr.resume();
      } catch {}
      setStatus('recording');
      startTimer();
      requestWakeLock();
      persistMeta(true);
    }
  };

  const stopRecording = () => {
    const mr = mrRef.current;
    userStopRef.current = true;
    if (mr && mr.state !== 'inactive') {
      try {
        mr.requestData?.(); // flush the current chunk immediately
      } catch {}
      try {
        mr.stop();
      } catch {}
    }
  };

  // Turn the saved chunks (an interrupted recording, or one that was never uploaded) into a file. The saved copy
  // stays until the upload is confirmed.
  const recoverRecording = async () => {
    try {
      const chunks = await getAllChunks();
      chunks.sort((a, b) => a.seq - b.seq);
      if (chunks.length) {
        const recoverMime = recovery?.mime || MIME;
        const blob = new Blob(
          chunks.map((c) => c.blob),
          { type: recoverMime },
        );
        const file = new File(
          [blob],
          `recording-recovered-${Date.now()}.${extForMime(recoverMime)}`,
          {
            type: blob.type,
          },
        );
        file.recorded = true;
        setRecovery(null);
        onComplete(file, { recovered: true, seconds: recovery?.duration });
      } else {
        setRecovery(null);
      }
    } catch {
      setError('Could not recover the previous recording.');
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

  const meter = Math.max(0, Math.min(100, ((level + 70) / 70) * 100));

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error}</p>}

      {recovery && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            <p className="text-sm font-medium text-amber-800">
              {recovery.pending
                ? `A recording that was not uploaded yet was found (${fmt(recovery.duration)}). Keep it?`
                : `A recording was interrupted (${fmt(recovery.duration)}). Keep what was captured?`}
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

      {!recovery && status === 'idle' && (
        <div className="flex flex-col gap-3">
          <Button onClick={beginRecording} className="w-full h-14 text-base rounded-full">
            <Mic className="w-5 h-5 mr-2" /> Start recording
          </Button>
          <label className="w-full">
            <input type="file" accept={AUDIO_ACCEPT} className="hidden" onChange={onFileChange} />
            <span className="flex items-center justify-center h-14 w-full rounded-full border border-input bg-secondary text-secondary-foreground cursor-pointer text-base">
              <Upload className="w-5 h-5 mr-2" /> Upload audio file
            </span>
          </label>
        </div>
      )}

      {!recovery && status !== 'idle' && (
        <div className="rounded-2xl border border-border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {status === 'recording' ? (
                <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
              ) : (
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
              )}
              <span className="font-medium">{status === 'recording' ? 'Recording' : 'Paused'}</span>
            </div>
            <span className="text-2xl font-mono tabular-nums">{fmt(elapsed)}</span>
          </div>
          {status === 'recording' && (
            <div>
              <div
                className="h-2 rounded-full bg-secondary overflow-hidden"
                role="meter"
                aria-label="Microphone level"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(meter)}
              >
                <div
                  className="h-full bg-emerald-500 transition-all duration-150"
                  style={{ width: `${meter}%` }}
                />
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">Microphone level</p>
            </div>
          )}
          {muted && (
            <p
              role="alert"
              className="text-xs rounded-lg bg-amber-50 border border-amber-200 text-amber-900 p-2.5"
            >
              The microphone was interrupted (a call, another app or a Bluetooth change?). Sound may
              be missing until it comes back. Keep this screen open.
            </p>
          )}
          {silent && !muted && (
            <p
              role="alert"
              className="text-xs rounded-lg bg-amber-50 border border-amber-200 text-amber-900 p-2.5"
            >
              No sound for 10 seconds. Check that the microphone is not covered and that a call or
              another app has not taken it.
            </p>
          )}
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            Auto-saving. Keep this screen on and this page open: locking the phone or switching apps
            can pause the microphone.
          </p>
          <div className="flex gap-2">
            {status === 'recording' ? (
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
