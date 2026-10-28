import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Pause, Play } from 'lucide-react';
import { api } from '@/api/client';
import { fmtTime } from '@/lib/format';

/**
 * Every voice sample saved for one person, each playable from the recording it was cut from. These clips are
 * the only thing a new voice is compared with, so a profile that holds two different people (or someone
 * else's voice) can be heard here.
 */
export default function VoiceSamples({ personId, name }) {
  const [samples, setSamples] = useState(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(null);
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

  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!samples)
    return (
      <div className="flex justify-center py-3">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  if (!samples.length)
    return <p className="text-xs text-muted-foreground">No voice samples saved for {name}.</p>;

  return (
    <div className="space-y-1.5" data-testid={`samples-${personId}`}>
      {samples.map((s, i) => (
        <div key={s.index} className="flex items-center gap-2 text-xs">
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
        </div>
      ))}
      <audio ref={audio} onTimeUpdate={onTime} onEnded={() => setPlaying(null)} preload="none" />
    </div>
  );
}
