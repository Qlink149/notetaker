import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, Loader2, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { api } from '@/api/client';
import { useKept } from '@/lib/keptStore';
import { SkyArt } from '@/components/kept/bits';
import TaskRow from '@/components/kept/TaskRow';
import {
  daysUntil,
  firstName,
  greeting,
  initialsOf,
  isoDay,
  phaseNow,
  textOn,
  today,
} from '@/lib/kept';

const ORDER = { high: 0, med: 1, low: 2 };
const byPriority = (a, b) => ORDER[a.priority] - ORDER[b.priority];
const byDue = (a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999');

const groupOf = (t) =>
  !t.due
    ? 'No date'
    : daysUntil(t.due) === 1
      ? 'Tomorrow'
      : daysUntil(t.due) < 7
        ? 'This week'
        : 'Later';

function Section({ title, count, hint, children, onAdd, sectionRef, first }) {
  return (
    <div className={`${first ? 'mt-6 lg:mt-0' : 'mt-6'} k-fadein scroll-mt-6`} ref={sectionRef}>
      <div className="k-sech">
        <h2>{title}</h2>
        {count !== undefined && <span className="k-n">{count}</span>}
        {hint && <span className="k-hint">{hint}</span>}
        {onAdd && (
          <button type="button" className="k-add" onClick={onAdd} aria-label="Add a task">
            <Plus className="w-[18px] h-[18px]" strokeWidth={2} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * My tasks: due today, past their date, and coming up; suggested tasks from meetings to review. On a desktop the
 * lists take the left column and the suggestions and today's finished tasks sit on the right.
 */
export default function Today() {
  const { me, tasks, suggestions, people, refresh, openForm, openReview, openProfile } = useKept();
  const [showDone, setShowDone] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const refs = { today: useRef(null), late: useRef(null), up: useRef(null) };
  const phase = phaseNow();
  const mePerson = people.find((p) => p.id === me);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // desktop: the latest meetings beside the lists, one click away
  const [recent, setRecent] = useState([]);
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.meetings.list(4))
      .then((list) => live && setRecent(list ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const all = tasks ?? [];
  // without a "me", every open task is shown as mine (one person uses the workspace)
  const isMine = (t) => !me || t.ownerId === me || t.buddyId === me;
  const open = all.filter((t) => t.status === 'open' && isMine(t));
  const dueToday = open.filter((t) => daysUntil(t.due) === 0).sort(byPriority);
  const late = open.filter((t) => t.due && daysUntil(t.due) < 0).sort(byDue);
  const upcoming = open.filter((t) => !t.due || daysUntil(t.due) > 0).sort(byDue);
  const doneToday = all.filter(
    (t) => t.status === 'done' && isMine(t) && t.doneAt && isoDay(t.doneAt) === today(),
  );

  const reload = async () => {
    setSpinning(true);
    await refresh();
    setTimeout(() => setSpinning(false), 400);
  };
  const jump = (ref) => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="-mx-4 -mt-6 lg:mx-0 lg:mt-0">
      <div className={`k-hero ${textOn(phase) === 'dark' ? 'k-dark' : ''} h-[262px] lg:h-[230px]`}>
        <SkyArt phase={phase} />
        <div className="k-in">
          <div className="flex items-center justify-between">
            <span className="k-wordmark lg:invisible">Kept.</span>
            <span className="flex gap-2">
              <button type="button" className="k-glass" onClick={reload} aria-label="Refresh">
                <RefreshCw className={`w-[18px] h-[18px] ${spinning ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                className="k-glass lg:hidden"
                onClick={openProfile}
                aria-label="Profile"
              >
                {mePerson ? initialsOf(mePerson.name) : 'Me'}
              </button>
            </span>
          </div>
          <div className="k-date mt-auto">
            {new Date().toLocaleDateString('en-IN', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </div>
          <h1 className="!m-0">
            {greeting()},
            <br className="lg:hidden" /> {mePerson ? firstName(mePerson.name) : 'there'}.
          </h1>
          <div className="h-[52px] lg:h-[60px]" />
        </div>
      </div>

      <div className="k-summary lg:max-w-[560px]" data-testid="today-summary">
        <button type="button" onClick={() => jump(refs.today)}>
          <b>{dueToday.length}</b>
          <span>Today</span>
        </button>
        <button
          type="button"
          className={late.length ? 'k-late' : ''}
          onClick={() => jump(refs.late)}
        >
          <b>{late.length}</b>
          <span>Pending</span>
        </button>
        <button type="button" onClick={() => jump(refs.up)}>
          <b>{upcoming.length}</b>
          <span>Upcoming</span>
        </button>
      </div>

      {/* phones: one column (prompts, lists, done); desktop: lists left, prompts and done right */}
      <div className="px-4 lg:px-0 lg:mt-8 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[auto_auto_1fr] lg:gap-x-8 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="lg:col-start-2 lg:row-start-1 space-y-3 pt-4 lg:pt-0">
          {!me && people.length > 0 && (
            <button type="button" className="k-suggest" onClick={openProfile}>
              <span className="k-icon k-ac bg-white">
                <Sparkles className="w-[18px] h-[18px]" />
              </span>
              <span>
                <b>Who are you?</b>
                <small>Pick yourself once, so “My tasks” shows your tasks.</small>
              </span>
              <ChevronRight className="w-[18px] h-[18px] ml-auto text-[var(--k-accent)]" />
            </button>
          )}
          {suggestions.length > 0 && (
            <button
              type="button"
              className="k-suggest"
              onClick={() => openReview()}
              data-testid="suggested"
            >
              <span className="k-icon k-ac bg-white">
                <Sparkles className="w-[18px] h-[18px]" />
              </span>
              <span>
                <b>
                  {suggestions.length} suggested task{suggestions.length === 1 ? '' : 's'}
                </b>
                <small>From your meetings’ action items · tap to review</small>
              </span>
              <ChevronRight className="w-[18px] h-[18px] ml-auto text-[var(--k-accent)]" />
            </button>
          )}
          <button
            type="button"
            className="k-btn k-ghost !h-11 !text-sm hidden lg:flex"
            onClick={() => openForm({ ownerId: me, due: today() })}
          >
            <Plus className="w-4 h-4" strokeWidth={2.2} /> New task
          </button>
        </div>

        <div className="lg:col-start-1 lg:row-start-1 lg:row-span-3">
          {!tasks ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <Section
                first
                title="Today"
                count={dueToday.length}
                sectionRef={refs.today}
                onAdd={() => openForm({ ownerId: me, due: today() })}
              >
                <div className="k-list">
                  {dueToday.length ? (
                    dueToday.map((t) => <TaskRow key={t.id} task={t} />)
                  ) : (
                    <div className="k-empty">Nothing due today. Enjoy the calm ✦</div>
                  )}
                </div>
              </Section>
              {late.length > 0 && (
                <Section
                  title="Pending"
                  count={late.length}
                  hint="past their date"
                  sectionRef={refs.late}
                >
                  <div className="k-list">
                    {late.map((t) => (
                      <TaskRow key={t.id} task={t} />
                    ))}
                  </div>
                </Section>
              )}
              <Section title="Upcoming" count={upcoming.length} sectionRef={refs.up}>
                <div className="k-list">
                  {upcoming.length ? (
                    upcoming.map((t, i) => {
                      const g = groupOf(t);
                      const head = i === 0 || groupOf(upcoming[i - 1]) !== g;
                      return (
                        <div key={t.id}>
                          {head && <div className="k-group">{g}</div>}
                          <TaskRow task={t} />
                        </div>
                      );
                    })
                  ) : (
                    <div className="k-empty">Nothing coming up yet.</div>
                  )}
                </div>
              </Section>
            </>
          )}
        </div>

        {recent.length > 0 && (
          <div
            className="hidden lg:block lg:col-start-2 lg:row-start-3 mt-8"
            data-testid="recent-meetings"
          >
            <div className="k-sech">
              <h2 className="!text-[22px]">Recent meetings</h2>
              <Link to="/meetings" className="k-hint hover:text-[var(--k-ink)]">
                All
              </Link>
            </div>
            <div className="k-list">
              {recent.map((m) => (
                <Link key={m.id} to={`/meetings/${m.id}`} className="k-srch">
                  <span className="min-w-0">
                    <b className="truncate">{m.title}</b>
                    <small>
                      {m.status === 'processing'
                        ? 'Processing…'
                        : new Date(m.date).toLocaleDateString('en-IN', {
                            weekday: 'short',
                            day: 'numeric',
                            month: 'short',
                          })}
                    </small>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {doneToday.length > 0 && (
          <div className="mt-4 lg:mt-6 lg:col-start-2 lg:row-start-2">
            <button
              type="button"
              className="k-donefold"
              onClick={() => setShowDone((x) => !x)}
              aria-expanded={showDone}
            >
              <Check className="w-4 h-4" strokeWidth={2.2} /> {doneToday.length} completed today
              <span className="text-[var(--k-faint)]">· {showDone ? 'hide' : 'show'}</span>
            </button>
            {showDone && (
              <div className="k-list mt-2.5">
                {doneToday.map((t) => (
                  <TaskRow key={t.id} task={t} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
