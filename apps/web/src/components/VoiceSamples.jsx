import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Pause, Play } from 'lucide-react';
import { api } from '@/api/client';
import { fmtTime } from '@/lib/format';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * Every voice sample saved for one person, each playable from the recording it was cut from. These clips are
 * the only thing a new voice is compared with, so a profile that holds two different people (or someone
 * else's voice) can be heard here, and a wrong clip can be removed. A removed clip stays in the list, greyed
 * out, and can be restored.
 */
export default function VoiceSamples({ personId, name, onChanged }) {
  const [samples, setSamples] = useState(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [ignoreRest, setIgnoreRest] = useState(false);
  const [busy, setBusy] = useState(false);
  const audio = useRef(null);
  const playingRef = useRef(null);
  playingRef.current = samples?.find((s) => s.index === playing) ?? null;

  useEffect(() => {
    let live = true;
    api.speakers
      .samples(personId)
      .then((list) => live && setSamples(list))
      .catch(() => live && setError('Could not load the voice samples.'));
    return () => {
      live = false;
      audio.current?.pause();
    };
  }, [personId]);

  const stop = () => {
    audio.current?.pause();
    setPlaying(null);
  };

  const play = (s) => {
    const el = audio.current;
    if (!el || !s.audioUrl) return;
    if (playing === s.index) return stop();
    setPlaying(s.index);
    const go = () => {
      el.currentTime = s.start;
      el.play().catch(() => setPlaying(null));
    };
    if (el.getAttribute('src') !== s.audioUrl) {
      el.src = s.audioUrl;
      el.addEventListener('loadedmetadata', go, { once: true });
      el.load();
    } else go();
  };

  const onTime = () => {
    const el = audio.current;
    const s = playingRef.current;
    if (el && s?.end != null && el.currentTime >= s.end) stop();
  };

  const change = async (call) => {
    setBusy(true);
    setError('');
    try {
      setSamples(await call());
      onChanged?.();
    } catch {
      setError('That did not work. Nothing was changed.');
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  };

  const askToRemove = (s) => {
    stop();
    // a wrong voice confirmed in that meeting probably means its other clips are wrong too
    setIgnoreRest(Boolean(s.meetingId && s.meetingConfirmed));
    setRemoving(s);
  };

  if (!samples && error) return <p className="text-xs text-destructive">{error}</p>;
  if (!samples)
    return (
      <div className="flex justify-center py-3">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  if (!samples.length)
    return <p className="text-xs text-muted-foreground">No voice samples saved for {name}.</p>;

  const activeCount = samples.filter((s) => !s.removed).length;

  return (
    <div className="space-y-1.5" data-testid={`samples-${personId}`}>
      {samples.map((s, i) => (
        <div
          key={s.key}
          className={`flex items-center gap-2 text-xs flex-wrap ${s.removed ? 'opacity-60' : ''}`}
        >
          <button
            type="button"
            onClick={() => play(s)}
            disabled={!s.audioUrl}
            aria-label={`${playing === s.index ? 'Stop' : 'Play'} sample ${i + 1} of ${name}`}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-border hover:bg-secondary disabled:opacity-50"
          >
            {playing === s.index ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
            {s.seconds != null ? `${Math.round(s.seconds)} s` : 'Play'}
          </button>
          <span className="text-muted-foreground">
            {s.meetingId ? (
              <>
                <Link
                  to={`/meetings/${s.meetingId}?t=${Math.floor(s.start)}`}
                  className="underline"
                >
                  {s.meetingTitle}
                </Link>{' '}
                at {fmtTime(s.start)}
              </>
            ) : s.source === 'enrolment' ? (
              'Recorded for this person'
            ) : (
              'Recording no longer available'
            )}
          </span>
          {s.removed ? (
            <>
              <span className="text-muted-foreground">Removed</span>
              <button
                type="button"
                disabled={busy}
                className="underline"
                aria-label={`Restore sample ${i + 1} of ${name}`}
                onClick={() => change(() => api.speakers.restoreSample(personId, s.key))}
              >
                Restore
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              className="underline text-muted-foreground hover:text-foreground"
              aria-label={`Remove sample ${i + 1} of ${name}`}
              onClick={() => askToRemove(s)}
            >
              Remove
            </button>
          )}
        </div>
      ))}
      {activeCount === 0 && (
        <p className="text-xs text-amber-700">
          {name} will not be recognised until a new voice is learned.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <audio ref={audio} onTimeUpdate={onTime} onEnded={() => setPlaying(null)} preload="none" />

      <AlertDialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this voice sample?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.meetingTitle
                ? `${removing.meetingTitle} at ${fmtTime(removing.start)}`
                : 'Recorded sample'}
              {removing?.seconds != null ? `, ${Math.round(removing.seconds)} s` : ''}. New meetings
              will no longer be compared with this clip. Names already on past meetings do not
              change. You can restore it.
              {removing &&
                activeCount === 1 &&
                ` ${name} will not be recognised until a new voice is learned.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removing?.meetingId && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={ignoreRest}
                onChange={(e) => setIgnoreRest(e.target.checked)}
              />
              <span>
                Also ignore {name}&apos;s other voices from this meeting
                {removing.meetingConfirmed
                  ? ' (that voice was confirmed as this person, so its other clips may be wrong too)'
                  : ''}
              </span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                change(() =>
                  api.speakers.removeSample(personId, removing.key, { ignoreMeeting: ignoreRest }),
                );
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
