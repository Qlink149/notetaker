import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Mic, Plus } from 'lucide-react';
import { api } from '@/api/client';
import { useKept } from '@/lib/keptStore';
import { Avatar } from '@/components/kept/bits';
import { fmtDuration } from '@/lib/format';
import { niceDay, isoDay } from '@/lib/kept';

const BADGES = {
  processing: { label: 'Processing', className: 'text-muted-foreground', spin: true },
  uploaded: { label: 'Queued', className: 'text-muted-foreground', spin: true },
  partial: { label: 'Partial', className: 'text-amber-600' },
  failed: { label: 'Failed', className: 'text-destructive' },
};

/** First sentence of the summary that is not a heading: what the meeting was about. */
function gist(summary) {
  const line = (summary ?? '')
    .split('\n')
    .map((l) =>
      l
        .replace(/^[-*#>\s]+/, '')
        .replace(/\*\*/g, '')
        .trim(),
    )
    .find((l) => l.length > 20);
  return line ? (line.length > 140 ? `${line.slice(0, 140)}…` : line) : '';
}

export default function Meetings() {
  const [meetings, setMeetings] = useState(null);
  const { tasks, suggestions } = useKept();

  const load = async () => {
    try {
      setMeetings(await api.meetings.list(50));
    } catch {
      setMeetings((m) => m ?? []);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!meetings || !meetings.some((m) => m.status === 'processing')) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [meetings]);

  return (
    <div>
      <div className="k-ptitle">
        <h1>Meetings</h1>
        <p>Everything that was said, and who owns what.</p>
      </div>
      <Link to="/record" className="k-btn k-primary mt-4 mb-5">
        <Plus className="w-5 h-5" strokeWidth={2} /> New meeting
      </Link>

      {!meetings ? (
        <div className="flex justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : meetings.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <Mic className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <p className="mb-2">No meetings yet.</p>
          <Link to="/record" className="text-sm font-medium underline">
            Upload your first meeting
          </Link>
        </div>
      ) : (
        <div>
          {meetings.map((m) => {
            const badge = BADGES[m.status];
            const ts = (tasks ?? []).filter((t) => t.meetingId === m.id);
            const open = ts.filter((t) => t.status === 'open').length;
            const suggested = suggestions.filter((s) => s.meetingId === m.id).length;
            const about = gist(m.summary);
            return (
              <Link key={m.id} to={`/meetings/${m.id}`} className="k-mcard k-fadein">
                <div className="flex items-center justify-between gap-2.5">
                  <h3 className="text-base font-semibold truncate">{m.title}</h3>
                  {badge ? (
                    <span className={`flex items-center gap-1 text-xs shrink-0 ${badge.className}`}>
                      {badge.spin && <Loader2 className="w-3 h-3 animate-spin" />}
                      {badge.label}
                    </span>
                  ) : (
                    <span className="text-xs text-[var(--k-faint)] shrink-0">
                      {niceDay(isoDay(m.date))}
                    </span>
                  )}
                </div>
                <p className="text-[13px] text-[var(--k-sub)] leading-normal mt-1.5 mb-3">
                  {about || (
                    <>
                      {new Date(m.date).toLocaleString()}
                      {m.durationSec ? ` · ${fmtDuration(m.durationSec)}` : ''}
                    </>
                  )}
                </p>
                <div className="flex items-center justify-between gap-2.5 text-xs text-[var(--k-sub)]">
                  <div className="k-avstack">
                    {(m.participants ?? []).slice(0, 5).map((name) => (
                      <Avatar key={name} id={name} name={name} />
                    ))}
                    {(m.participants ?? []).length > 5 && (
                      <span className="k-mini" style={{ background: '#c9cbd8' }}>
                        +{m.participants.length - 5}
                      </span>
                    )}
                  </div>
                  <span>
                    {m.durationSec ? fmtDuration(m.durationSec) : ''}
                    {ts.length
                      ? ` · ${ts.length} task${ts.length === 1 ? '' : 's'} · ${open} open`
                      : ''}
                    {suggested ? ` · ${suggested} suggested` : ''}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
