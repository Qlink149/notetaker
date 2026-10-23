import { useRef, useState } from 'react';
import { useKept } from '@/lib/keptStore';
import { Avatar } from '@/components/kept/bits';
import { daysUntil, dueLabel, firstName, isoDay, niceDay } from '@/lib/kept';

const BURST = ['var(--pc)', '#c5b8ff', '#ffd0b8', '#a9dcc3'];

function burst(el) {
  const r = el.getBoundingClientRect();
  const color = getComputedStyle(el).getPropertyValue('--pc');
  for (let i = 0; i < 10; i++) {
    const d = document.createElement('span');
    const a = (i / 10) * Math.PI * 2;
    const dist = 22 + Math.random() * 12;
    d.className = 'k-burst';
    d.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px;--dx:${Math.cos(a) * dist}px;--dy:${Math.sin(a) * dist}px;--c:${BURST[i % 4]};--pc:${color}`;
    document.body.append(d);
    setTimeout(() => d.remove(), 700);
  }
}

/** A task in a list: tick it off (with a little celebration and Undo), or tap it for details. */
export default function TaskRow({ task: t }) {
  const { me, updateTask, openTask, toast } = useKept();
  const [checking, setChecking] = useState(false);
  const ck = useRef(null);
  const n = daysUntil(t.due);
  const done = t.status === 'done';
  const other = t.ownerId === me ? t.buddyId : t.ownerId;
  const otherName = t.ownerId === me ? t.buddyName : t.ownerName;
  const from =
    t.createdById && t.createdById !== me
      ? `from ${firstName(t.createdByName)}`
      : (t.meetingTitle ?? '');

  const check = () => {
    if (done) {
      updateTask(t.id, { status: 'open' }).catch(() => {});
      return;
    }
    setChecking(true);
    if (ck.current) burst(ck.current);
    navigator.vibrate?.([12, 40, 18]);
    setTimeout(async () => {
      try {
        await updateTask(t.id, { status: 'done' });
        toast('Nice — one less thing.', {
          label: 'Undo',
          onClick: () => updateTask(t.id, { status: 'open' }).catch(() => {}),
        });
      } catch {
        // updateTask already said so
      } finally {
        setChecking(false);
      }
    }, 1150);
  };

  return (
    <div
      className={`k-row p-${t.priority}${checking ? ' k-checking' : ''}${done ? ' k-done' : ''}`}
      data-testid="task-row"
    >
      <button
        ref={ck}
        type="button"
        className="k-ck"
        onClick={check}
        aria-label={done ? `Mark not done: ${t.title}` : `Mark done: ${t.title}`}
      >
        <svg viewBox="0 0 24 24">
          <path d="M7 12.5l3.2 3.2L17 9" />
        </svg>
      </button>
      <button type="button" className="k-rbody" onClick={() => openTask(t.id)}>
        <div className="k-ttl">{t.title}</div>
        <div className="k-meta">
          <span className="k-dot" />
          <span className={!done && n < 0 ? 'k-late' : !done && n === 0 ? 'k-soon' : ''}>
            {done ? (t.doneAt ? `Done ${niceDay(isoDay(t.doneAt))}` : 'Done') : dueLabel(t.due)}
          </span>
          {from && (
            <>
              <span className="k-sep">·</span>
              <span className="truncate max-w-[180px]">{from}</span>
            </>
          )}
          {other && me && (
            <span className="k-buddy">
              <Avatar id={other} name={otherName} />
              {t.ownerId === me ? 'with ' : 'for '}
              {firstName(otherName)}
            </span>
          )}
        </div>
      </button>
    </div>
  );
}
