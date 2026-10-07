import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, BarChart3 } from 'lucide-react';
import { api } from '@/api/client';

const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const usd = (x) => `$${(x ?? 0).toFixed(2)}`;

function Stat({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}

export default function Dashboard() {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api
      .dashboard()
      .then(setD)
      .catch((e) => setError(e?.message || 'Could not load.'));
  }, []);
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!d) return <Loader2 className="w-5 h-5 animate-spin" />;
  const t = d.totals;
  const gem = d.usage.engineCalls
    .filter((e) => e.engine.startsWith('gemini'))
    .reduce((s, e) => s + e.calls, 0);
  const dg = d.usage.engineCalls
    .filter((e) => e.engine === 'deepgram')
    .reduce((s, e) => s + e.calls, 0);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <BarChart3 className="w-6 h-6" /> Cost and quality
        </h1>
        <p className="text-sm text-muted-foreground">
          What the meetings cost and how far to trust them.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Stat label="Meetings" value={t.meetings} hint={`${t.hours} hours of audio`} />
        <Stat
          label="Spend recorded"
          value={usd(t.usdLedger)}
          hint="Gemini (if paid) + summaries; free-tier use costs nothing"
        />
        <Stat
          label="Average coverage"
          value={pct(t.averageCoverage)}
          hint={`${t.belowNinety} meeting(s) under 90%`}
        />
        <Stat
          label="Voice-checked speakers"
          value={`${t.voiceBacked} of ${t.meetings}`}
          hint="others use text matching between chunks"
        />
      </div>

      <section>
        <h2 className="font-semibold mb-2">Usage</h2>
        <div className="rounded-xl border border-border bg-card p-3 text-sm space-y-1.5">
          <p>
            Gemini replies stored: <b className="tabular-nums">{gem}</b> · Deepgram requests:{' '}
            <b className="tabular-nums">{dg}</b>
          </p>
          <p>
            pyannote jobs:{' '}
            {d.usage.pyannoteJobs.length
              ? d.usage.pyannoteJobs.map((p) => `${p.jobs} ${p.kind} (${p.status})`).join(', ')
              : 'none'}
            {' · '}diarized audio: <b className="tabular-nums">{d.usage.pyannoteHours} h</b>
          </p>
          <p className="text-xs text-muted-foreground">{d.usage.pyannoteCostNote}</p>
          {d.quotas.length > 0 && (
            <p className="text-xs text-amber-700">
              Gemini keys out of daily quota:{' '}
              {d.quotas
                .map((q) => `${q.key} until ${new Date(q.until).toLocaleTimeString()}`)
                .join('; ')}
            </p>
          )}
        </div>
      </section>

      {d.audit.length > 0 && (
        <section>
          <h2 className="font-semibold mb-2">Blind audit so far</h2>
          <div className="rounded-xl border border-border bg-card p-3 text-sm space-y-1">
            {d.audit.map((a) => (
              <p key={a.method}>
                {a.method === 'm1' ? 'Time overlap' : 'Word clock'}: speaker right{' '}
                {pct(a.speakerCorrectRate)} of {a.answered} judged, text matches{' '}
                {pct(a.textMatchRate)}
              </p>
            ))}
            <Link to="/audit" className="text-xs underline">
              Open the audit
            </Link>
          </div>
        </section>
      )}

      <section>
        <h2 className="font-semibold mb-2">Meetings</h2>
        <div className="space-y-2">
          {d.meetings.map((m) => (
            <Link
              key={m.id}
              to={`/meetings/${m.id}`}
              className="block rounded-xl border border-border bg-card p-3 hover:bg-secondary/40"
            >
              <div className="flex items-baseline gap-2">
                <p className="font-medium flex-1 truncate">{m.title}</p>
                <span className="text-xs text-muted-foreground">{m.status}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                {m.minutes ?? '–'} min · coverage {pct(m.coverage)} · {m.speakers} speakers (
                {m.speakerSource === 'pyannote' ? 'by voice' : 'by text'}) · {m.voices.confident}{' '}
                confident / {m.voices.needsReview} to review / {m.voices.newVoices} new ·{' '}
                {usd(m.usd)}
                {m.deepgramMin ? ` · Deepgram ${m.deepgramMin} min` : ''}
              </p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
