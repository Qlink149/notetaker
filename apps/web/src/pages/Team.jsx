import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Mic2, Plus } from 'lucide-react';
import { useKept } from '@/lib/keptStore';
import { Avatar, SkyArt, WhatsAppIcon } from '@/components/kept/bits';
import CopyMessage from '@/components/kept/CopyMessage';
import {
  daysUntil,
  dueLabel,
  firstName,
  isoDay,
  nudgeText,
  phaseNow,
  textOn,
  today,
  waLink,
} from '@/lib/kept';

/** Daily standup text for WhatsApp: each person's open tasks, late ones first. */
function standupText(rows) {
  const day = new Date().toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const parts = rows
    .filter((r) => r.open.length)
    .map(
      (r) =>
        `*${firstName(r.name)}*\n${r.open
          .slice(0, 5)
          .map(
            (t) =>
              `${daysUntil(t.due) < 0 ? '🔴' : daysUntil(t.due) === 0 ? '🟡' : '⚪️'} ${t.title} — ${dueLabel(t.due)}`,
          )
          .join('\n')}`,
    );
  return `☀️ *Standup · ${day}*\n\n${parts.join('\n\n')}`;
}

/** Everyone with tasks: open, due today, late and done today; expand a person to see their list. */
export default function Team() {
  const { me, tasks, people, openForm, openTask } = useKept();
  const [expanded, setExpanded] = useState({});
  const phase = phaseNow();
  const all = tasks ?? [];

  const ids = [...new Set([me, ...all.map((t) => t.ownerId)].filter(Boolean))];
  const rows = ids
    .map((id) => {
      const mine = all.filter((t) => t.ownerId === id);
      const open = mine
        .filter((t) => t.status === 'open')
        .sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9'));
      return {
        id,
        name: people.find((p) => p.id === id)?.name ?? mine[0]?.ownerName ?? 'Someone',
        open,
        late: open.filter((t) => t.due && daysUntil(t.due) < 0).length,
        dueToday: open.filter((t) => daysUntil(t.due) === 0).length,
        doneToday: mine.filter(
          (t) => t.status === 'done' && t.doneAt && isoDay(t.doneAt) === today(),
        ).length,
      };
    })
    .sort(
      (a, b) => (b.id === me) - (a.id === me) || b.late - a.late || b.open.length - a.open.length,
    );

  const standup = standupText(rows);

  return (
    <div className="-mx-4 -mt-6 lg:mx-0 lg:mt-0">
      <div className={`k-hero ${textOn(phase) === 'dark' ? 'k-dark' : ''} h-[190px]`}>
        <SkyArt phase={phase} seed={4.2} sunX={90} sunY={70} />
        <div className="k-in">
          <span className="k-wordmark lg:invisible">Kept.</span>
          <div className="k-date mt-auto">
            {new Date().toLocaleDateString('en-IN', {
              weekday: 'long',
              day: 'numeric',
              month: 'short',
            })}
          </div>
          <h1 className="!mt-0 mb-6">Team</h1>
        </div>
      </div>
      <div className="px-4 pt-4 lg:px-0 lg:pt-6">
        <div className="flex gap-2.5 lg:max-w-md">
          <button
            type="button"
            className="k-btn k-primary lg:!h-11 lg:!text-sm flex-1"
            onClick={() => openForm({ due: today() })}
          >
            <Plus className="w-[18px] h-[18px]" /> New task
          </button>
          <div className="flex flex-1 min-w-0 gap-2">
            <a
              className="k-btn k-wa lg:!h-11 lg:!text-sm min-w-0"
              href={waLink(standup)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <WhatsAppIcon /> Share standup
            </a>
            <CopyMessage text={standup} className="k-icon self-center" />
          </div>
        </div>
        <p className="mt-2 text-xs text-[var(--k-faint)] lg:max-w-md">
          Copy the message if WhatsApp Web asks you to log in.
        </p>

        <div className="mt-6 lg:grid lg:grid-cols-2 lg:gap-4 lg:items-start">
          {rows.length === 0 && (
            <div className="k-list lg:col-span-2">
              <div className="k-empty">
                No one has tasks yet. Approve suggested tasks on Today, or add one.
              </div>
            </div>
          )}
          {rows.map((r) => (
            <div className="k-pgroup k-fadein" key={r.id}>
              <div className="k-phead">
                <button
                  type="button"
                  className="flex items-center gap-3 flex-1 min-w-0 text-left"
                  aria-expanded={Boolean(expanded[r.id])}
                  onClick={() => setExpanded((x) => ({ ...x, [r.id]: !x[r.id] }))}
                >
                  <Avatar id={r.id} name={r.name} size="av" />
                  <div className="k-who">
                    <b>
                      {r.name}
                      {r.id === me && (
                        <span className="text-[var(--k-faint)] font-medium"> (you)</span>
                      )}
                    </b>
                    <div className="k-chips mt-1.5">
                      {r.dueToday > 0 ? (
                        <span className="k-chip">{r.dueToday} today</span>
                      ) : (
                        r.open.length > 0 && <span className="k-chip">{r.open.length} open</span>
                      )}
                      {r.late > 0 && <span className="k-chip k-hi">{r.late} late</span>}
                      {r.doneToday > 0 && <span className="k-chip k-ok">{r.doneToday} done</span>}
                      {!r.open.length && !r.doneToday && <span className="k-chip">All clear</span>}
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  className="k-icon k-ac"
                  aria-label={`Add task for ${firstName(r.name)}`}
                  onClick={() => openForm({ ownerId: r.id, due: today() })}
                >
                  <Plus className="w-[18px] h-[18px]" strokeWidth={2} />
                </button>
                {r.open.length > 0 && r.id !== me && (
                  <>
                    <a
                      className="k-icon k-wa"
                      href={waLink(nudgeText(r.name, r.open))}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Nudge ${firstName(r.name)} on WhatsApp`}
                    >
                      <WhatsAppIcon size={17} />
                    </a>
                    <CopyMessage text={nudgeText(r.name, r.open)} />
                  </>
                )}
              </div>
              {expanded[r.id] &&
                (r.open.length ? (
                  r.open.map((t) => (
                    <button
                      type="button"
                      key={t.id}
                      className={`k-srow p-${t.priority}`}
                      onClick={() => openTask(t.id)}
                    >
                      <span className="k-sdot" />
                      <span className="k-t">{t.title}</span>
                      <span className={`k-d ${daysUntil(t.due) < 0 ? 'k-late' : ''}`}>
                        {dueLabel(t.due)}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="k-srow cursor-default">
                    <span className="k-t text-[var(--k-faint)]">No open tasks</span>
                  </div>
                ))}
            </div>
          ))}
        </div>

        <Link to="/speakers" className="k-list k-act mt-2 lg:mt-6 lg:max-w-md">
          <span className="k-ic">
            <Mic2 className="w-[18px] h-[18px]" />
          </span>
          Speakers: everyone the app knows by voice
        </Link>
      </div>
    </div>
  );
}
