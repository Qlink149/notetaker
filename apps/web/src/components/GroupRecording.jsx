import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { Users, Loader2, FlaskConical, Play, Square, Wand2, X } from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// PROTOTYPE host panel: start a group recording, show who has joined, press Start / Stop, then
// combine the phones' audio into one meeting.

const STORE = 'meetingid_phone_base';
const readBase = () => {
  try {
    return window.localStorage.getItem(STORE) || window.location.origin;
  } catch {
    return window.location.origin;
  }
};

const STATE_TEXT = {
  lobby: 'Waiting for phones to join',
  recording: 'Recording',
  stopped: 'Stopped. Uploads may still be finishing',
  processing: "Combining the phones' audio…",
  done: 'Done',
  failed: 'Failed',
};
const STATUS_TEXT = {
  joined: 'joined',
  ready: 'ready',
  recording: 'recording',
  uploaded: 'uploaded',
  failed: 'failed',
};

function Meter({ level }) {
  const pct = level == null ? 0 : Math.max(0, Math.min(100, ((level + 70) / 70) * 100));
  return (
    <div className="h-1.5 w-16 rounded-full bg-secondary overflow-hidden" aria-label="Input level">
      <div
        className="h-full bg-emerald-500 transition-all duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default function GroupRecording() {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(null);
  const [base, setBase] = useState(readBase);
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const joinUrl = session ? `${base.replace(/\/$/, '')}/join/${session.code}` : '';

  useEffect(() => {
    if (!joinUrl) return;
    QRCode.toDataURL(joinUrl, { margin: 1, width: 240 })
      .then(setQr)
      .catch(() => setQr(''));
  }, [joinUrl]);

  // poll who has joined, their levels and the session state every 2 s
  useEffect(() => {
    if (!session || ['done', 'failed'].includes(session.state)) return;
    const t = setInterval(() => {
      api.sessions
        .get(session.code)
        .then(setSession)
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [session?.code, session?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = useCallback(async (fn) => {
    setBusy(true);
    setError('');
    try {
      setSession(await fn());
    } catch (e) {
      setError(e?.message || 'That did not work.');
    } finally {
      setBusy(false);
    }
  }, []);

  const saveBase = (v) => {
    setBase(v);
    try {
      window.localStorage.setItem(STORE, v);
    } catch {
      /* optional */
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-2xl border border-dashed border-border p-3 text-left hover:bg-secondary/50 flex items-center gap-3"
      >
        <Users className="w-5 h-5 text-muted-foreground shrink-0" />
        <span className="flex-1">
          <span className="block text-sm font-medium">Start a group recording</span>
          <span className="block text-xs text-muted-foreground">
            Several phones record one meeting; the best microphone is used for each voice.
          </span>
        </span>
        <span className="text-[10px] uppercase tracking-wide bg-amber-100 text-amber-900 rounded-full px-2 py-0.5">
          Prototype
        </span>
      </button>
    );
  }

  const people = session?.participants ?? [];
  const canStart = session?.state === 'lobby' && session.participants.length > 0;
  // Wait until every phone has handed over its last part (or has not been seen for a while).
  const settled = (p) =>
    p.status === 'uploaded' || p.status === 'failed' || p.secondsSinceSeen > 45;
  const allSettled = people.length > 0 && people.every(settled);
  const hasAudio = people.some((p) => p.parts > 0);

  return (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Users className="w-5 h-5" />
        <h2 className="font-semibold flex-1">Group recording</h2>
        <button
          className="text-muted-foreground"
          onClick={() => setOpen(false)}
          aria-label="Close group recording"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="rounded-xl border border-amber-300 bg-amber-50 text-amber-900 text-xs p-2.5 flex gap-2 items-start">
        <FlaskConical className="w-4 h-4 shrink-0 mt-0.5" />
        <span>Prototype: tested with synthetic tracks, not yet with real phones.</span>
      </div>

      {!session ? (
        <Button className="w-full" disabled={busy} onClick={() => act(() => api.sessions.create())}>
          {busy ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Users className="w-4 h-4 mr-2" />
          )}
          Create session
        </Button>
      ) : (
        <>
          {['lobby', 'recording'].includes(session.state) && (
            <div className="flex gap-4 items-center flex-wrap">
              {qr ? (
                <img
                  src={qr}
                  alt={`QR code to join ${session.code}`}
                  className="w-40 h-40 rounded-lg border border-border"
                />
              ) : (
                <div className="w-40 h-40 rounded-lg bg-secondary" />
              )}
              <div className="space-y-2 min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">
                  Scan with each phone, or open the address and type the code:
                </p>
                <p className="text-3xl font-bold tracking-[0.25em] tabular-nums">{session.code}</p>
                <label className="text-xs text-muted-foreground block" htmlFor="phone-base">
                  Address phones should open
                </label>
                <Input
                  id="phone-base"
                  value={base}
                  onChange={(e) => saveBase(e.target.value)}
                  className="h-8 text-xs"
                />
                {!base.startsWith('https://') && (
                  <p className="text-[11px] text-amber-700">
                    Phones need an https address to use the microphone (see the tunnel command in
                    the handover).
                  </p>
                )}
              </div>
            </div>
          )}

          <div>
            <p className="text-sm font-medium mb-1.5">
              {STATE_TEXT[session.state]}
              {session.state === 'recording' && (
                <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse ml-2" />
              )}
            </p>
            {people.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nobody has joined yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {people.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 text-sm">
                    <span className="font-medium flex-1 truncate">{p.name}</span>
                    <Meter level={p.status === 'uploaded' ? null : p.level} />
                    <span className="text-xs text-muted-foreground w-24 text-right">
                      {p.secondsSinceSeen > 10 && p.status !== 'uploaded'
                        ? 'not seen'
                        : STATUS_TEXT[p.status]}
                      {p.parts ? ` · ${p.parts} part${p.parts > 1 ? 's' : ''}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex gap-2 flex-wrap">
            {session.state === 'lobby' && (
              <Button
                disabled={busy || !canStart}
                onClick={() => act(() => api.sessions.start(session.code))}
              >
                <Play className="w-4 h-4 mr-1" /> Start recording
              </Button>
            )}
            {session.state === 'recording' && (
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => act(() => api.sessions.stop(session.code))}
              >
                <Square className="w-4 h-4 mr-1" /> Stop
              </Button>
            )}
            {session.state === 'stopped' && (
              <>
                <Button
                  disabled={busy || !hasAudio || !allSettled}
                  onClick={() => act(() => api.sessions.finish(session.code))}
                >
                  <Wand2 className="w-4 h-4 mr-1" /> Combine and process
                </Button>
                {hasAudio && !allSettled && (
                  <>
                    <span className="text-xs text-muted-foreground self-center">
                      Waiting for every phone to finish uploading…
                    </span>
                    <button
                      className="text-xs underline text-muted-foreground"
                      disabled={busy}
                      onClick={() => act(() => api.sessions.finish(session.code))}
                    >
                      Combine anyway
                    </button>
                  </>
                )}
              </>
            )}
          </div>

          {session.state === 'processing' && (
            <p className="text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Aligning the phones and mixing. This
              runs on the server.
              {session.meetingId && (
                <Link className="underline" to={`/meetings/${session.meetingId}`}>
                  Open the meeting
                </Link>
              )}
            </p>
          )}
          {session.state === 'done' && session.meetingId && (
            <div className="space-y-2">
              <Link to={`/meetings/${session.meetingId}`} className="text-sm underline font-medium">
                Open the meeting
              </Link>
              {session.report?.tracks && (
                <div className="text-xs text-muted-foreground space-y-0.5">
                  {session.report.tracks.map((t) => (
                    <p key={t.name}>
                      {t.name}:{' '}
                      {t.method === 'reference'
                        ? 'used as the reference'
                        : t.method === 'envelope'
                          ? `aligned (shift ${t.fineSec} s, clock drift ${t.driftPpm} ppm)`
                          : 'aligned by timestamps only'}
                    </p>
                  ))}
                  <p>{session.report.switches} microphone switches in the mix</p>
                </div>
              )}
            </div>
          )}
          {session.state === 'failed' && (
            <p className="text-sm text-destructive">
              {session.error || 'Combining the audio failed.'}
            </p>
          )}
        </>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
