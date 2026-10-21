import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, Check, Loader2, Search as SearchIcon } from 'lucide-react';
import { api } from '@/api/client';
import { useKept } from '@/lib/keptStore';
import { dueLabel } from '@/lib/kept';
import { fmtTime } from '@/lib/format';

/** `text` with every query word marked. */
function Marked({ text, q }) {
  const words = q
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return text;
  const parts = String(text).split(new RegExp(`(${words.join('|')})`, 'gi'));
  return parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p));
}

/** Tasks (here) and meetings: titles, summaries, action items and what was said (on the server). */
export default function Search() {
  const { tasks, openTask } = useKept();
  const [q, setQ] = useState('');
  const [meetings, setMeetings] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setMeetings([]);
      return;
    }
    setBusy(true);
    let live = true;
    const t = setTimeout(() => {
      api
        .search(query)
        .then((r) => live && setMeetings(r))
        .catch(() => live && setMeetings([]))
        .finally(() => live && setBusy(false));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const words = q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  const has = (s) => words.every((w) => s.toLowerCase().includes(w));
  const taskHits = words.length
    ? (tasks ?? []).filter((t) =>
        has(`${t.title} ${t.ownerName} ${t.buddyName ?? ''} ${t.meetingTitle ?? ''}`),
      )
    : [];

  return (
    <div>
      <div className="k-ptitle">
        <h1>Search</h1>
        <p>Your team’s memory.</p>
      </div>
      <div className="relative mt-4">
        <SearchIcon className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[var(--k-faint)]" />
        <input
          className="k-inp"
          style={{ paddingLeft: 44 }}
          placeholder="Search everything"
          aria-label="Search"
          autoComplete="off"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {busy && (
          <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-[var(--k-faint)]" />
        )}
      </div>
      <div className="mt-3.5">
        {!words.length ? (
          <div className="k-empty py-10">
            Search tasks, meetings and what was said.
            <br />
            <span className="text-xs">Try a project, a store or a colleague’s name.</span>
          </div>
        ) : taskHits.length || meetings.length ? (
          <div className="k-list" data-testid="search-results">
            {taskHits.map((t) => (
              <button type="button" key={t.id} className="k-srch" onClick={() => openTask(t.id)}>
                <span className="k-ic">
                  <Check className="w-[17px] h-[17px]" />
                </span>
                <div>
                  <b>
                    <Marked text={t.title} q={q} />
                  </b>
                  <small>
                    {t.ownerName} · {t.status === 'done' ? 'Done' : dueLabel(t.due)}
                  </small>
                </div>
              </button>
            ))}
            {meetings.map((m) => (
              <Link
                key={m.meetingId}
                to={`/meetings/${m.meetingId}${m.at != null ? `?t=${Math.floor(m.at)}` : ''}`}
                className="k-srch"
              >
                <span className="k-ic">
                  <CalendarDays className="w-[17px] h-[17px]" />
                </span>
                <div className="min-w-0">
                  <b>
                    <Marked text={m.title} q={q} />
                  </b>
                  <small>
                    {m.at != null && <span className="tabular-nums">{fmtTime(m.at)} · </span>}
                    <Marked text={m.snippet} q={q} />
                  </small>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          !busy && <div className="k-empty py-10">Nothing found for “{q.trim()}”.</div>
        )}
      </div>
    </div>
  );
}
