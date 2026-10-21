import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart3,
  Check,
  ChevronRight,
  Gauge,
  Loader2,
  LogOut,
  Mic2,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
} from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';
import { useKept } from '@/lib/keptStore';
import { FEATURES } from '@/lib/features';
import { Avatar, Sheet, SkyArt, WhatsAppIcon } from '@/components/kept/bits';
import TaskRow from '@/components/kept/TaskRow';
import {
  daysUntil,
  dueLabel,
  firstName,
  greeting,
  initialsOf,
  isoDay,
  nudgeText,
  phaseNow,
  textOn,
  today,
  waLink,
} from '@/lib/kept';

const ORDER = { high: 0, med: 1, low: 2 };
const byPriority = (a, b) => ORDER[a.priority] - ORDER[b.priority];
const byDue = (a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999');

/** Who "me" is, Speakers, Settings, sign out. */
function ProfileSheet({ onClose }) {
  const { people, me, setMe, toast } = useKept();
  const { logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const mine = people.find((p) => p.id === me);
  return (
    <Sheet title={mine?.name ?? 'You'} onClose={onClose}>
      <div className="px-[18px] pb-4">
        <div className="k-lbl">This is me</div>
        <select
          className="k-inp"
          aria-label="This is me"
          value={me ?? ''}
          disabled={busy}
          onChange={async (e) => {
            setBusy(true);
            try {
              await setMe(e.target.value || null);
              toast('Saved. “My tasks” now follows this person.');
            } catch (err) {
              toast(err?.message || 'Could not save.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="">Choose a person from the speaker directory…</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-[var(--k-sub)] mt-2 px-1">
          Your tasks, the ones you give others, and “Given by” use this person.
        </p>
        <div className="k-list mt-4">
          <Link to="/speakers" className="k-act" onClick={onClose}>
            <span className="k-ic">
              <Mic2 className="w-[18px] h-[18px]" />
            </span>
            Speakers (voice directory)
          </Link>
          {FEATURES.insights && (
            <Link to="/dashboard" className="k-act" onClick={onClose}>
              <span className="k-ic">
                <BarChart3 className="w-[18px] h-[18px]" />
              </span>
              Insights
            </Link>
          )}
          {FEATURES.benchmark && (
            <Link to="/benchmark" className="k-act" onClick={onClose}>
              <span className="k-ic">
                <Gauge className="w-[18px] h-[18px]" />
              </span>
              Benchmark
            </Link>
          )}
          <Link to="/settings" className="k-act" onClick={onClose}>
            <span className="k-ic">
              <Settings className="w-[18px] h-[18px]" />
            </span>
            Settings
          </Link>
          <button type="button" className="k-act k-red" onClick={logout}>
            <span className="k-ic">
              <LogOut className="w-[18px] h-[18px]" />
            </span>
            Sign out
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function Section({ title, count, hint, children, onAdd, sectionRef }) {
  return (
    <div className="mt-6 k-fadein" ref={sectionRef}>
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

/** My tasks (today, pending, upcoming) or the ones I gave others, grouped by person. */
export default function Today() {
  const { me, tasks, suggestions, people, refresh, openForm, openReview, openTask } = useKept();
  const [seg, setSeg] = useState('mine');
  const [showDone, setShowDone] = useState(false);
  const [profile, setProfile] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const refs = { today: useRef(null), late: useRef(null), up: useRef(null) };
  const phase = phaseNow();
  const mePerson = people.find((p) => p.id === me);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  const delegated = me
    ? all.filter(
        (t) =>
          t.createdById === me &&
          t.ownerId !== me &&
          (t.status === 'open' || (t.doneAt && daysUntil(isoDay(t.doneAt)) >= -1)),
      )
    : [];
  const byOwner = new Map();
  for (const t of delegated) byOwner.set(t.ownerId, [...(byOwner.get(t.ownerId) ?? []), t]);
  const lateCount = (list) =>
    list.filter((t) => t.status === 'open' && daysUntil(t.due) < 0).length;
  const owners = [...byOwner].sort((a, b) => lateCount(b[1]) - lateCount(a[1]));

  const groupOf = (t) =>
    !t.due
      ? 'No date'
      : daysUntil(t.due) === 1
        ? 'Tomorrow'
        : daysUntil(t.due) < 7
          ? 'This week'
          : 'Later';

  const reload = async () => {
    setSpinning(true);
    await refresh();
    setTimeout(() => setSpinning(false), 400);
  };

  return (
    <div className="-mx-4 -mt-6">
      <div className={`k-hero ${textOn(phase) === 'dark' ? 'k-dark' : ''}`} style={{ height: 262 }}>
        <SkyArt phase={phase} />
        <div className="k-in">
          <div className="flex items-center justify-between">
            <span className="k-wordmark">Kept.</span>
            <span className="flex gap-2">
              <button type="button" className="k-glass" onClick={reload} aria-label="Refresh">
                <RefreshCw className={`w-[18px] h-[18px] ${spinning ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                className="k-glass"
                onClick={() => setProfile(true)}
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
            <br />
            {mePerson ? firstName(mePerson.name) : 'there'}.
          </h1>
          <div className="h-[52px]" />
        </div>
      </div>

      <div className="k-summary" data-testid="today-summary">
        <button
          type="button"
          onClick={() => refs.today.current?.scrollIntoView({ behavior: 'smooth' })}
        >
          <b>{dueToday.length}</b>
          <span>Today</span>
        </button>
        <button
          type="button"
          className={late.length ? 'k-late' : ''}
          onClick={() => refs.late.current?.scrollIntoView({ behavior: 'smooth' })}
        >
          <b>{late.length}</b>
          <span>Pending</span>
        </button>
        <button
          type="button"
          onClick={() => refs.up.current?.scrollIntoView({ behavior: 'smooth' })}
        >
          <b>{upcoming.length}</b>
          <span>Upcoming</span>
        </button>
      </div>

      <div className="px-4">
        {!me && people.length > 0 && (
          <button type="button" className="k-suggest mt-4" onClick={() => setProfile(true)}>
            <span className="k-icon k-ac bg-white">
              <Sparkles className="w-[18px] h-[18px]" />
            </span>
            <span>
              <b>Who are you?</b>
              <small>Pick yourself once, so “My tasks” and “Delegated” know.</small>
            </span>
            <ChevronRight className="w-[18px] h-[18px] ml-auto text-[var(--k-accent)]" />
          </button>
        )}
        {suggestions.length > 0 && (
          <button
            type="button"
            className="k-suggest mt-4"
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

        <div className="k-seg mt-5" role="group" aria-label="Whose tasks">
          <button type="button" aria-pressed={seg === 'mine'} onClick={() => setSeg('mine')}>
            My tasks
          </button>
          <button type="button" aria-pressed={seg === 'del'} onClick={() => setSeg('del')}>
            Delegated
          </button>
        </div>

        {!tasks ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : seg === 'mine' ? (
          <>
            <Section
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
            {doneToday.length > 0 && (
              <div className="mt-4">
                <button type="button" className="k-donefold" onClick={() => setShowDone((x) => !x)}>
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
          </>
        ) : (
          <Section
            title="Delegated"
            count={`${delegated.filter((t) => t.status === 'open').length} open`}
          >
            {!me ? (
              <div className="k-list">
                <div className="k-empty">
                  Pick who you are (profile button) to see the tasks you gave.
                </div>
              </div>
            ) : owners.length ? (
              owners.map(([pid, list]) => {
                const name = list[0].ownerName;
                const openList = list.filter((t) => t.status === 'open');
                const lateN = lateCount(list);
                return (
                  <div className="k-pgroup" key={pid}>
                    <div className="k-phead">
                      <Avatar id={pid} name={name} size="av" />
                      <div className="k-who">
                        <b>{name}</b>
                        <small>
                          {openList.length} open
                          {lateN > 0 && <span className="k-late"> · {lateN} late</span>}
                        </small>
                      </div>
                      {openList.length > 0 && (
                        <a
                          className="k-icon k-wa"
                          href={waLink(nudgeText(name, openList))}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Nudge ${firstName(name)} on WhatsApp`}
                        >
                          <WhatsAppIcon />
                        </a>
                      )}
                    </div>
                    {[...list]
                      .sort((a, b) => (a.status === 'done') - (b.status === 'done') || byDue(a, b))
                      .map((t) => (
                        <button
                          type="button"
                          key={t.id}
                          className={`k-srow p-${t.priority}${t.status === 'done' ? ' k-done' : ''}`}
                          onClick={() => openTask(t.id)}
                        >
                          <span className="k-sdot" />
                          <span className="k-t">{t.title}</span>
                          <span
                            className={`k-d ${t.status === 'open' && daysUntil(t.due) < 0 ? 'k-late' : ''}`}
                          >
                            {t.status === 'done' ? 'Done' : dueLabel(t.due)}
                          </span>
                        </button>
                      ))}
                  </div>
                );
              })
            ) : (
              <div className="k-list">
                <div className="k-empty">Tasks you give others will wait here.</div>
              </div>
            )}
          </Section>
        )}
      </div>
      {profile && <ProfileSheet onClose={() => setProfile(false)} />}
    </div>
  );
}
