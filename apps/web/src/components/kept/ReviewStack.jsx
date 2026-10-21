import { useEffect, useRef, useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { useKept } from '@/lib/keptStore';
import { Avatar, SkyArt } from '@/components/kept/bits';
import { PRIORITY_LABEL, dueLabel, niceDay } from '@/lib/kept';

const PHASES = ['evening', 'morning', 'afternoon'];
/** How far a card is dragged before it counts as approve / skip. */
const SWIPE_PX = 90;

/**
 * Suggested tasks from meetings' action items, one card at a time: swipe right (or ✓) to add it, left (or ✕)
 * to skip it, ✎ to change it first. A card whose owner is not known yet opens the form instead of approving.
 */
export default function ReviewStack({ list, total, approved, onApproved, onClose }) {
  const { people, createTask, skipSuggestion, openForm, toast } = useKept();
  const [leaving, setLeaving] = useState(null); // 'ok' | 'no'
  const card = useRef(null);
  const drag = useRef(null);
  const top = list[0];
  const done = total - list.length;
  const nameOf = (id) => people.find((p) => p.id === id)?.name ?? null;

  const edit = (s) =>
    openForm({
      title: s.title,
      ownerId: s.ownerId,
      priority: s.priority,
      due: s.due,
      meetingId: s.meetingId,
      fromSuggestion: { meetingId: s.meetingId, index: s.index },
      speakerName: s.speakerName,
    });

  const resolve = async (ok) => {
    if (!top || leaving) return;
    if (ok && !top.ownerId) {
      toast('Pick who’s doing it first.');
      edit(top);
      return;
    }
    setLeaving(ok ? 'ok' : 'no');
    try {
      await new Promise((r) => setTimeout(r, 280));
      if (ok) {
        await createTask({
          title: top.title,
          ownerId: top.ownerId,
          priority: top.priority,
          due: top.due,
          fromSuggestion: { meetingId: top.meetingId, index: top.index },
        });
        onApproved();
      } else await skipSuggestion(top);
    } catch (e) {
      toast(e?.message || 'Could not save. Try again.');
    } finally {
      setLeaving(null);
      if (card.current) card.current.style.transform = '';
    }
  };

  useEffect(() => {
    const onKey = (e) => {
      if (document.querySelector('.k-sheet')) return;
      if (e.key === 'ArrowRight') resolve(true);
      if (e.key === 'ArrowLeft') resolve(false);
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const stamp = (dx) => {
    const el = card.current;
    if (!el) return;
    el.querySelector('.k-stamp.k-ok').style.opacity = String(
      Math.max(0, Math.min(1, dx / SWIPE_PX)),
    );
    el.querySelector('.k-stamp.k-no').style.opacity = String(
      Math.max(0, Math.min(1, -dx / SWIPE_PX)),
    );
  };
  const onDown = (e) => {
    drag.current = { x: e.clientX, y: e.clientY, dx: 0 };
    card.current?.classList.add('k-drag');
    card.current?.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    drag.current.dx = dx;
    card.current.style.transform = `translate(${dx}px, ${(e.clientY - drag.current.y) * 0.2}px) rotate(${dx / 18}deg)`;
    stamp(dx);
  };
  const onUp = () => {
    if (!drag.current) return;
    const { dx } = drag.current;
    drag.current = null;
    card.current?.classList.remove('k-drag');
    if (dx > SWIPE_PX) resolve(true);
    else if (dx < -SWIPE_PX) resolve(false);
    else {
      card.current.style.transform = '';
      stamp(0);
    }
  };

  if (!top)
    return (
      <div className="k-stackwrap" data-testid="review-stack">
        <div className="k-stackdone">
          <div
            className="w-[92px] h-[92px] rounded-full grid place-items-center"
            style={{ background: 'radial-gradient(circle at 35% 30%, #a9dcc3, #4d9b77)' }}
          >
            <Check className="w-10 h-10" strokeWidth={2.2} />
          </div>
          <h3>All reviewed</h3>
          <p className="opacity-85 mb-6">
            {approved} task{approved === 1 ? '' : 's'} added.
          </p>
          <button
            type="button"
            className="k-btn max-w-[260px]"
            style={{ background: '#fff', color: 'var(--k-ink)' }}
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    );

  return (
    <div className="k-stackwrap" data-testid="review-stack">
      <div className="k-stackhead">
        <div className="flex-1">
          <h3>Suggested tasks</h3>
          <small>Swipe right to add, left to skip</small>
        </div>
        <button type="button" className="k-glass text-white" onClick={onClose} aria-label="Close">
          <X className="w-[18px] h-[18px]" />
        </button>
      </div>
      <div className="k-progress" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <i key={i} className={i < done ? 'k-d' : ''} />
        ))}
      </div>
      <div className="k-stack">
        {list
          .slice(0, 3)
          .map((s, i) => (
            <div
              key={`${s.meetingId}-${s.index}`}
              ref={i === 0 ? card : undefined}
              className="k-scard"
              data-depth={i}
              style={{
                zIndex: 10 - i,
                ...(i === 0 && leaving
                  ? {
                      transition: 'transform .4s var(--k-ease), opacity .4s',
                      transform: `translateX(${leaving === 'ok' ? 520 : -520}px) rotate(${leaving === 'ok' ? 24 : -24}deg)`,
                      opacity: 0,
                    }
                  : {}),
              }}
              {...(i === 0
                ? {
                    onPointerDown: onDown,
                    onPointerMove: onMove,
                    onPointerUp: onUp,
                    onPointerCancel: onUp,
                  }
                : {})}
            >
              <SkyArt phase={PHASES[(done + i) % 3]} fade={false} seed={1 + (done + i) * 1.7} />
              <span className="k-stamp k-ok">ADD</span>
              <span className="k-stamp k-no">SKIP</span>
              <div className="k-kicker">
                Task {done + i + 1} of {total} · {s.meetingTitle}
              </div>
              <h4>{s.title}</h4>
              <div className="k-fields">
                <div className="k-fieldrow">
                  <span className="k-k">Owner</span>
                  {s.ownerId ? (
                    <>
                      <Avatar id={s.ownerId} name={nameOf(s.ownerId)} />
                      <b>{nameOf(s.ownerId)}</b>
                    </>
                  ) : (
                    <b style={{ color: 'var(--k-hi)' }}>Pick someone ({s.speakerName})</b>
                  )}
                </div>
                <div className="k-fieldrow">
                  <span className="k-k">Deadline</span>
                  <b>{dueLabel(s.due)}</b>
                  {s.due && <span className="text-xs text-[var(--k-faint)]">{niceDay(s.due)}</span>}
                </div>
                <div className={`k-fieldrow p-${s.priority}`}>
                  <span className="k-k">Priority</span>
                  <span className="k-dot" />
                  <b>{PRIORITY_LABEL[s.priority]}</b>
                </div>
              </div>
              <div className="k-quote">“{s.quote}”</div>
            </div>
          ))
          .reverse()}
      </div>
      <div className="k-stackbtns">
        <button
          type="button"
          className="k-sbtn k-no"
          onClick={() => resolve(false)}
          aria-label="Skip"
        >
          <X className="w-7 h-7" strokeWidth={2.2} />
        </button>
        <button
          type="button"
          className="k-sbtn k-ok"
          onClick={() => resolve(true)}
          aria-label="Approve"
        >
          <Check className="w-8 h-8" strokeWidth={2.4} />
        </button>
        <button type="button" className="k-sbtn k-ed" onClick={() => edit(top)} aria-label="Edit">
          <Pencil className="w-[22px] h-[22px]" />
        </button>
      </div>
    </div>
  );
}
