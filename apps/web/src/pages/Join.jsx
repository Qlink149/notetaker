import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, Mic, FlaskConical, Check, AlertTriangle } from 'lucide-react';
import { api } from '@/api/client';
import { uploadToCloudinary } from '@/lib/cloudinaryUpload';
import { PhoneRecorder, encodeWav, partStore } from '@/lib/phoneRecorder';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// PROTOTYPE guest page: no login. The phone joins with a name, records the microphone when the host
// presses Start, uploads 60 s parts as it goes, and stops when the host stops.

const credKey = (code) => `meetingid_join_${code}`;
const loadCreds = (code) => {
  try {
    return JSON.parse(window.localStorage.getItem(credKey(code)) || 'null');
  } catch {
    return null;
  }
};

function PrototypeBanner() {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 text-amber-900 text-xs p-2.5 flex gap-2 items-start mb-4">
      <FlaskConical className="w-4 h-4 shrink-0 mt-0.5" />
      <span>Prototype: tested with synthetic tracks, not yet with real phones.</span>
    </div>
  );
}

export default function Join() {
  const { code: rawCode } = useParams();
  const code = (rawCode || '').toUpperCase();
  const [name, setName] = useState('');
  const [step, setStep] = useState('name'); // name | joining | ready | recording | finishing | done
  const [error, setError] = useState('');
  const [level, setLevel] = useState(-100);
  const [title, setTitle] = useState('');
  const [uploaded, setUploaded] = useState(0);
  const [pending, setPending] = useState(0);
  const [recovered, setRecovered] = useState(0);

  const creds = useRef(null);
  const recorder = useRef(null);
  const clock = useRef({ offset: 0, rtt: Infinity });
  const firstServerMs = useRef(null);
  const levelRef = useRef(-100);
  const recording = useRef(false);
  const queue = useRef(Promise.resolve());
  const wake = useRef(null);
  const pendingCount = useRef(0);

  // ---- uploading: sequential, retried, saved locally until the server has it ----
  const uploadPart = useCallback(
    async (part, auth) => {
      const key = `${code}:${auth.pid}:${part.index}`;
      await partStore.put(key, part);
      for (let attempt = 0; ; attempt++) {
        try {
          const sig = await api.join.sign(code, auth);
          const up = await uploadToCloudinary(part.wav, sig);
          await api.join.part(code, {
            ...auth,
            index: part.index,
            publicId: up.publicId,
            url: up.url,
            bytes: part.wav.size,
            startSample: part.startSample,
            ...(part.firstSampleServerMs != null
              ? { firstSampleServerMs: part.firstSampleServerMs }
              : {}),
          });
          await partStore.del(key);
          setUploaded((n) => n + 1);
          return;
        } catch (e) {
          if (attempt >= 8) throw e;
          await new Promise((r) => setTimeout(r, Math.min(30000, 1500 * 2 ** attempt)));
        }
      }
    },
    [code],
  );

  const enqueueUpload = useCallback(
    (part) => {
      pendingCount.current++;
      setPending(pendingCount.current);
      const auth = creds.current;
      queue.current = queue.current
        .then(() => uploadPart(part, auth))
        .catch(() =>
          setError(
            'Some audio could not be uploaded. Keep this page open and check your connection.',
          ),
        )
        .finally(() => {
          pendingCount.current--;
          setPending(pendingCount.current);
        });
      return queue.current;
    },
    [uploadPart],
  );

  // ---- finishing ----
  const finish = useCallback(async () => {
    if (!recording.current) return;
    recording.current = false;
    setStep('finishing');
    recorder.current?.stop();
    await queue.current;
    await partStore.del(`${code}:${creds.current.pid}:partial`);
    recorder.current?.close();
    wake.current?.release?.().catch(() => {});
    try {
      await api.join.heartbeat(code, { ...creds.current, status: 'uploaded', level: null });
    } catch {
      /* the host can still see our parts */
    }
    setStep('done');
  }, [code]);

  // ---- heartbeat: tells us when to start/stop, reports our level, measures the clock ----
  const heartbeat = useCallback(async () => {
    if (!creds.current) return;
    const sent = Date.now();
    try {
      const s = await api.join.heartbeat(code, {
        ...creds.current,
        level: Math.round(levelRef.current),
        status: recording.current ? 'recording' : 'ready',
      });
      const rtt = Date.now() - sent;
      if (rtt < clock.current.rtt)
        clock.current = { rtt, offset: s.serverNowMs - (sent + rtt / 2) };
      setTitle(s.title);
      if (s.state === 'recording' && !recording.current && recorder.current) {
        recording.current = true;
        recorder.current.begin();
        setStep('recording');
        try {
          wake.current = await navigator.wakeLock?.request('screen');
        } catch {
          /* optional */
        }
      } else if (s.state !== 'lobby' && s.state !== 'recording' && recording.current) {
        await finish();
      }
    } catch (e) {
      if (e?.status === 401)
        setError('This phone is no longer part of the recording. Rejoin with the code.');
    }
  }, [code, finish]);

  useEffect(() => {
    if (!['ready', 'recording'].includes(step)) return;
    const t = setInterval(heartbeat, 2000);
    return () => clearInterval(t);
  }, [step, heartbeat]);

  // save the unfinished part locally every 2 s so a crash or reload loses almost nothing
  useEffect(() => {
    if (step !== 'recording') return;
    const t = setInterval(() => {
      const snap = recorder.current?.snapshot();
      if (snap && creds.current)
        partStore.put(`${code}:${creds.current.pid}:partial`, {
          ...snap,
          firstSampleServerMs: firstServerMs.current,
        });
    }, 2000);
    return () => clearInterval(t);
  }, [step, code]);

  // level meter refresh
  useEffect(() => {
    const t = setInterval(() => setLevel(levelRef.current), 200);
    return () => clearInterval(t);
  }, []);

  // upload anything left from an earlier visit of this phone (reload, crash, flaky network)
  useEffect(() => {
    const saved = loadCreds(code);
    if (!saved) return;
    (async () => {
      const keys = (await partStore.keys()).filter((k) =>
        String(k).startsWith(`${code}:${saved.pid}:`),
      );
      let n = 0;
      for (const k of keys) {
        const v = await partStore.get(k);
        if (!v) continue;
        const isPartial = String(k).endsWith(':partial');
        const part = isPartial
          ? {
              index: v.index,
              startSample: v.startSample,
              wav: encodeWav(v.pcm),
              firstSampleServerMs: v.firstSampleServerMs,
            }
          : v;
        try {
          await uploadPart(part, saved);
          if (isPartial) await partStore.del(k);
          n++;
        } catch {
          /* stays saved for the next visit */
        }
      }
      if (n) setRecovered(n);
    })();
  }, [code, uploadPart]);

  const join = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError('');
    setStep('joining');
    try {
      const r = await api.join.join(code, trimmed, navigator.userAgent.slice(0, 100));
      creds.current = { pid: r.participantId, token: r.token };
      window.localStorage.setItem(credKey(code), JSON.stringify(creds.current));
      setTitle(r.title);
      const rec = new PhoneRecorder({
        onLevel: (db) => (levelRef.current = db),
        onPart: (p) =>
          enqueueUpload({
            ...p,
            firstSampleServerMs: firstServerMs.current,
          }),
        onFirstSample: (clientMs) => {
          firstServerMs.current = clientMs + clock.current.offset;
        },
      });
      try {
        await rec.open();
      } catch {
        setError('The microphone is blocked. Allow microphone access for this page and try again.');
        setStep('name');
        return;
      }
      recorder.current = rec;
      setStep('ready');
      await heartbeat();
      if (r.state === 'recording') await heartbeat();
    } catch (e) {
      setError(e?.message || 'Could not join.');
      setStep('name');
    }
  };

  useEffect(
    () => () => {
      recorder.current?.close();
    },
    [],
  );

  const meter = Math.max(0, Math.min(100, ((level + 70) / 70) * 100));

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-md mx-auto px-4 py-8">
        <PrototypeBanner />
        <h1 className="text-2xl font-bold tracking-tight mb-1">Join the recording</h1>
        <p className="text-sm text-muted-foreground mb-5">
          Code <b className="tracking-widest">{code}</b>
          {title ? ` · ${title}` : ''}
        </p>

        {step === 'name' || step === 'joining' ? (
          <div className="space-y-3">
            <label className="text-sm font-medium" htmlFor="name">
              Your name
            </label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && join()}
              placeholder="e.g. Anil"
              autoFocus
              className="h-11"
            />
            <Button
              className="w-full h-11"
              disabled={!name.trim() || step === 'joining'}
              onClick={join}
            >
              {step === 'joining' ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Mic className="w-4 h-4 mr-2" />
              )}
              Join and allow microphone
            </Button>
            <p className="text-xs text-muted-foreground">
              Your phone records the room's sound while the host's recording runs. Put it on the
              table and leave this page open.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl border border-border bg-card p-4">
              <div className="flex items-center gap-2 mb-3">
                {step === 'recording' ? (
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                ) : step === 'done' ? (
                  <Check className="w-4 h-4 text-emerald-600" />
                ) : (
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                )}
                <p className="font-semibold">
                  {step === 'ready' && 'Ready. Waiting for the host to press Start…'}
                  {step === 'recording' && 'Recording. Keep this page open.'}
                  {step === 'finishing' && 'Finishing and uploading…'}
                  {step === 'done' && 'Done. You can close this page.'}
                </p>
              </div>
              {step !== 'done' && (
                <div>
                  <div
                    className="h-2.5 rounded-full bg-secondary overflow-hidden"
                    aria-label="Microphone level"
                  >
                    <div
                      className="h-full bg-emerald-500 transition-all duration-150"
                      style={{ width: `${meter}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Microphone level{level < -60 ? ' (very quiet; is the microphone covered?)' : ''}
                  </p>
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">
              {uploaded} part{uploaded === 1 ? '' : 's'} uploaded
              {pending ? `, ${pending} uploading` : ''}
              {recovered ? ` · recovered ${recovered} saved part(s) from an earlier visit` : ''}
            </p>
          </div>
        )}

        {error && (
          <p className="mt-4 text-sm text-destructive flex gap-2 items-start">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </p>
        )}
      </div>
    </div>
  );
}
