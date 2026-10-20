import { Fragment, useEffect, useRef, useState } from 'react';
import { fmtTime, lineText } from '@/lib/format';

// Height reserved for the sticky player bar.
const STICKY_OFFSET = 72;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

const PALETTE = [
  'bg-blue-100 text-blue-700',
  'bg-emerald-100 text-emerald-700',
  'bg-purple-100 text-purple-700',
  'bg-rose-100 text-rose-700',
  'bg-cyan-100 text-cyan-700',
  'bg-indigo-100 text-indigo-700',
];

function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// The line covering the playback position, else the most recent line that started before it.
function activeIndexFor(lines, t) {
  if (!lines?.length) return -1;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (t >= lines[i].start && t <= lines[i].end) return i;
    if (lines[i].start <= t) idx = i;
    else break;
  }
  return idx;
}

/**
 * scriptMode: "roman" | "native" | "both". Lines never exceed 45 s (built server-side).
 * When `onReassign` / `onSplit` are given, clicking a speaker's name opens line actions:
 * `speakers` is [{ diar, displayName }] of the meeting.
 */
export default function TranscriptView({
  lines,
  currentTime = 0,
  onSeek,
  scriptMode = 'roman',
  speakers = [],
  onReassign,
  onSplit,
  follow = false,
  onUserScroll,
  onActiveVisible,
  jumpRef,
  parts = [],
}) {
  const rowRefs = useRef([]);
  const [menu, setMenu] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = activeIndexFor(lines, currentTime);
  const editable = Boolean(onReassign || onSplit);

  // The active line is always highlighted. The page only moves when the user turned follow on.
  const isVisible = (el) => {
    if (!el) return true;
    const r = el.getBoundingClientRect();
    return r.top >= STICKY_OFFSET && r.bottom <= window.innerHeight;
  };
  const centre = (el) => el?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Follow on: jump to the active line once, then only when it leaves the screen (no jitter on every line).
  const wasFollowing = useRef(false);
  useEffect(() => {
    const justTurnedOn = follow && !wasFollowing.current;
    wasFollowing.current = follow;
    if (!follow || active < 0) return;
    const el = rowRefs.current[active];
    if (justTurnedOn || !isVisible(el)) centre(el);
  }, [active, follow]);

  // Any manual scroll (wheel, trackpad, touch, keyboard) turns follow off and never pulls the user back.
  useEffect(() => {
    if (!follow || !onUserScroll) return;
    const stop = () => onUserScroll();
    const key = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT|AUDIO)$/.test(e.target?.tagName || '')) return;
      if (SCROLL_KEYS.has(e.key)) stop();
    };
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('touchmove', stop, { passive: true });
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchmove', stop);
      window.removeEventListener('keydown', key);
    };
  }, [follow, onUserScroll]);

  // Tell the page whether the active line is on screen (for the "Now playing" pill).
  useEffect(() => {
    if (!onActiveVisible) return;
    const report = () => onActiveVisible(active < 0 || isVisible(rowRefs.current[active]));
    report();
    window.addEventListener('scroll', report, { passive: true });
    window.addEventListener('resize', report);
    return () => {
      window.removeEventListener('scroll', report);
      window.removeEventListener('resize', report);
    };
  }, [active, onActiveVisible]);

  // "Now playing" pill: scroll to the active line once, without turning follow on.
  useEffect(() => {
    if (jumpRef) jumpRef.current = () => centre(rowRefs.current[active]);
  });

  const act = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setMenu(-1);
    } catch (e) {
      setError(e?.message || 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  if (!lines?.length) return <p className="text-sm text-muted-foreground">No transcript yet.</p>;

  // A meeting uploaded in several files: mark where each later file starts (the first line at or after it).
  const partAt = new Map();
  parts.forEach((p, k) => {
    if (k === 0 || p.offsetSec == null) return;
    const i = lines.findIndex((l) => l.start >= p.offsetSec - 0.5);
    if (i >= 0 && !partAt.has(i)) partAt.set(i, { n: k + 1, name: p.fileName });
  });

  return (
    <div className="space-y-3">
      {lines.map((line, i) => {
        const isActive = i === active;
        const showBoth =
          scriptMode === 'both' && line.textNative && line.textNative !== line.textRoman;
        const chipClass = `text-xs font-semibold px-2 py-0.5 rounded-full ${colorFor(line.speakerName)}`;
        const part = partAt.get(i);
        return (
          <Fragment key={i}>
            {part && (
              <div
                className="flex items-center gap-2 text-xs text-muted-foreground pt-2"
                data-testid="part-divider"
              >
                <span className="h-px flex-1 bg-border" />
                <span>
                  Part {part.n}
                  {part.name ? ` · ${part.name}` : ''}
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            <div
              ref={(el) => (rowRefs.current[i] = el)}
              onClick={onSeek ? () => onSeek(line.start) : undefined}
              className={`rounded-xl p-3 transition-colors ${onSeek ? 'cursor-pointer' : ''} ${
                isActive
                  ? 'bg-primary/5 border-2 border-primary/40 ring-1 ring-primary/30'
                  : 'bg-card border border-border'
              }`}
            >
              <div className="flex items-center gap-2 mb-1.5">
                {editable ? (
                  <button
                    type="button"
                    className={`${chipClass} underline decoration-dotted underline-offset-2`}
                    aria-expanded={menu === i}
                    aria-label={`${line.speakerName}: change who said this`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenu(menu === i ? -1 : i);
                      setError('');
                    }}
                  >
                    {line.speakerName}
                  </button>
                ) : (
                  <span className={chipClass}>{line.speakerName}</span>
                )}
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {fmtTime(line.start)}
                </span>
              </div>
              {showBoth ? (
                <>
                  <p className="text-sm leading-relaxed text-foreground">{line.textRoman}</p>
                  <p className="text-sm leading-relaxed text-muted-foreground mt-1">
                    {line.textNative}
                  </p>
                </>
              ) : (
                <p className="text-sm leading-relaxed text-foreground">
                  {lineText(line, scriptMode === 'native' ? 'native' : 'roman')}
                </p>
              )}
              {editable && menu === i && (
                <div
                  className="mt-2.5 pt-2.5 border-t border-border flex flex-wrap items-center gap-2 text-xs"
                  onClick={(e) => e.stopPropagation()}
                >
                  {onReassign && (
                    <label className="flex items-center gap-1.5">
                      Move this line to
                      <select
                        disabled={busy}
                        defaultValue=""
                        onChange={(e) => e.target.value && act(() => onReassign(i, e.target.value))}
                        className="h-8 rounded-md border border-input bg-background px-2"
                      >
                        <option value="">choose…</option>
                        {speakers
                          .filter((s) => s.displayName !== line.speakerName)
                          .map((s) => (
                            <option key={s.diar} value={s.diar}>
                              {s.displayName}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  {onSplit && (
                    <button
                      disabled={busy}
                      onClick={() => act(() => onSplit(i))}
                      className="h-8 px-2.5 rounded-md border border-input hover:bg-secondary"
                    >
                      This is a different person from here on
                    </button>
                  )}
                  {error && <span className="text-destructive">{error}</span>}
                </div>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
