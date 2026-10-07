import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Loader2, Check, ListChecks, BarChart3 } from 'lucide-react';
import { api } from '@/api/client';
import { fmtTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const SPEAKER = [
  { v: 'right', label: 'Right', key: 'r' },
  { v: 'wrong', label: 'Wrong', key: 'w' },
  { v: 'unsure', label: "Can't tell", key: 'u' },
];
const TEXT = [
  { v: 'match', label: 'Matches', key: '1' },
  { v: 'partly', label: 'Partly', key: '2' },
  { v: 'no', label: 'No', key: '3' },
];
const pct = (x) => (x == null ? '–' : `${Math.round(x * 1000) / 10}%`);

function Choice({ options, value, onPick, name }) {
  return (
    <div className="flex gap-2 flex-wrap" role="radiogroup" aria-label={name}>
      {options.map((o) => (
        <button
          key={o.v}
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onPick(o.v)}
          className={`px-4 py-2 rounded-full border text-sm font-medium transition-colors ${
            value === o.v
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-card border-border hover:bg-secondary'
          }`}
        >
          {o.label} <span className="opacity-60 text-xs">({o.key})</span>
        </button>
      ))}
    </div>
  );
}

function Results() {
  const [r, setR] = useState(null);
  useEffect(() => {
    api.audit
      .results()
      .then(setR)
      .catch(() => setR({ methods: [], shortLines: [], note: '' }));
  }, []);
  if (!r) return <Loader2 className="w-5 h-5 animate-spin" />;
  const label = { m1: 'M1 · time overlap', m3: 'M3 · word clock' };
  const table = (rows, title) => (
    <div className="mb-5">
      <h3 className="text-sm font-semibold mb-2">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 pr-3">Method</th>
              <th className="pr-3">Judged</th>
              <th className="pr-3">Speaker right</th>
              <th className="pr-3">Wrong name</th>
              <th className="pr-3">Text matches</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.method} className="border-t border-border">
                <td className="py-2 pr-3 font-medium">{label[t.method] ?? t.method}</td>
                <td className="pr-3 tabular-nums">{t.answered}</td>
                <td className="pr-3 tabular-nums">
                  {pct(t.speakerCorrectRate)}{' '}
                  <span className="text-xs text-muted-foreground">
                    ({t.right}/{t.answered}; {t.unsure} can't tell)
                  </span>
                </td>
                <td className="pr-3 tabular-nums">
                  {pct(t.wrongNameRate)}{' '}
                  <span className="text-xs text-muted-foreground">({t.wrong})</span>
                </td>
                <td className="pr-3 tabular-nums">
                  {pct(t.textMatchRate)}{' '}
                  <span className="text-xs text-muted-foreground">
                    ({t.textMatch}/{t.textAnswered})
                  </span>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="py-3 text-muted-foreground">
                  Nothing judged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
  return (
    <div>
      {table(r.methods, 'All judged lines')}
      {table(r.shortLines, 'Short lines only (under 3 s)')}
      <p className="text-xs text-muted-foreground">
        Decision rule: the method with the higher “speaker right” rate wins. Within 3 points, prefer
        the one that needs fewer Gemini calls and keeps Gemini's text unchanged (both do tonight).
        Below 85 %, stop and investigate.
      </p>
    </div>
  );
}

export default function Audit() {
  const [meetings, setMeetings] = useState(null);
  const [current, setCurrent] = useState(null);
  const [detail, setDetail] = useState(null);
  const [step, setStep] = useState('naming');
  const [names, setNames] = useState({});
  const [sameAs, setSameAs] = useState({});
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showResults, setShowResults] = useState(false);
  const audioRef = useRef(null);
  const stopAt = useRef(null);

  const loadList = useCallback(
    () =>
      api.audit
        .list()
        .then(setMeetings)
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    loadList();
  }, [loadList]);

  const open = useCallback(async (id) => {
    setCurrent(id);
    setDetail(null);
    setError('');
    try {
      const d = await api.audit.get(id);
      setDetail(d);
      setNames(Object.fromEntries(d.clusters.map((c) => [c.diar, c.name])));
      setSameAs(Object.fromEntries(d.clusters.map((c) => [c.diar, c.sameAs])));
      const firstOpen = d.items.findIndex((i) => !i.speaker || !i.text);
      setIdx(firstOpen < 0 ? d.items.length : firstOpen);
      setStep(d.clusters.some((c) => c.name) || firstOpen > 0 ? 'items' : 'naming');
    } catch (e) {
      if (e.status === 409) {
        await api.audit.seed(id);
        return open(id);
      }
      setError(e.message);
    }
  }, []);

  const play = useCallback((start, end, lead = 0) => {
    const a = audioRef.current;
    if (!a) return;
    stopAt.current = end;
    a.currentTime = Math.max(0, start - lead);
    a.play().catch(() => {});
  }, []);

  const item = detail?.items[idx];
  const saveNaming = async () => {
    setBusy(true);
    try {
      await api.audit.saveNaming(current, names, sameAs);
      const d = await api.audit.get(current);
      setDetail(d);
      setStep('items');
      loadList();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const answer = useCallback(
    async (patch) => {
      if (!detail || !item) return;
      const next = { ...item, ...patch };
      setDetail((d) => ({ ...d, items: d.items.map((i, k) => (k === idx ? next : i)) }));
      try {
        await api.audit.answer(current, item.id, patch);
      } catch (e) {
        setError(e.message);
        return;
      }
      if (next.speaker && next.text) {
        setTimeout(() => {
          setIdx((i) => i + 1);
          loadList();
        }, 250);
      }
    },
    [detail, item, idx, current, loadList],
  );

  // Autoplay the line when a new item appears, and keyboard shortcuts while judging.
  useEffect(() => {
    if (step === 'items' && item) play(item.start, item.end, 1);
  }, [step, item?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (step !== 'items' || !item) return;
    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
      const s = SPEAKER.find((o) => o.key === e.key.toLowerCase());
      const t = TEXT.find((o) => o.key === e.key);
      if (s) answer({ speaker: s.v });
      else if (t) answer({ text: t.v });
      else if (e.key.toLowerCase() === 'p') play(item.start, item.end, 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, item, answer, play]);

  const done = useMemo(
    () => detail?.items.filter((i) => i.speaker && i.text).length ?? 0,
    [detail],
  );

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1 flex items-center gap-2">
        <ListChecks className="w-6 h-6" /> Blind audit
      </h1>
      <p className="text-sm text-muted-foreground mb-4">
        Name each voice from its samples, then judge sampled lines. You are not told which method
        made a line. About 25 minutes for all meetings.
      </p>

      <div className="flex gap-2 flex-wrap mb-5">
        {(meetings ?? []).map((m) => (
          <button
            key={m.id}
            onClick={() => {
              setShowResults(false);
              open(m.id);
            }}
            className={`px-3 py-1.5 rounded-full border text-sm ${current === m.id && !showResults ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border'}`}
          >
            {m.title}{' '}
            <span className="opacity-70 text-xs">
              {m.answered}/{m.items}
            </span>
          </button>
        ))}
        <button
          onClick={() => setShowResults(true)}
          className={`px-3 py-1.5 rounded-full border text-sm inline-flex items-center gap-1 ${showResults ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border'}`}
        >
          <BarChart3 className="w-3.5 h-3.5" /> Results
        </button>
      </div>
      {meetings && !meetings.length && (
        <p className="text-sm text-muted-foreground">No joined meetings to audit yet.</p>
      )}
      {error && <p className="text-sm text-destructive mb-3">{error}</p>}

      {detail?.meeting?.playbackUrl && (
        <audio
          ref={audioRef}
          src={detail.meeting.playbackUrl}
          preload="auto"
          onTimeUpdate={(e) => {
            if (stopAt.current !== null && e.target.currentTime >= stopAt.current) {
              e.target.pause();
              stopAt.current = null;
            }
          }}
        />
      )}

      {showResults && <Results />}

      {!showResults && current && !detail && <Loader2 className="w-5 h-5 animate-spin" />}

      {!showResults && detail && step === 'naming' && (
        <div className="space-y-3">
          <h2 className="font-semibold">1. Who is who? ({detail.meeting.title})</h2>
          <p className="text-xs text-muted-foreground">
            Listen to the samples and type a name. If two voices are the same person, pick “same
            person as”. Leave a voice blank if you cannot tell.
          </p>
          {detail.clusters.map((c) => (
            <div key={c.diar} className="rounded-xl border border-border bg-card p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <b className="text-sm">{c.label}</b>
                <span className="text-xs text-muted-foreground">
                  {Math.round(c.seconds / 60) >= 1
                    ? `${Math.round(c.seconds / 60)} min`
                    : `${c.seconds} s`}{' '}
                  of speech
                </span>
                <div className="flex gap-1.5 ml-auto flex-wrap">
                  {c.clips.map((cl, i) => (
                    <button
                      key={i}
                      onClick={() => play(cl.start, cl.end)}
                      className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-border hover:bg-secondary"
                    >
                      <Play className="w-3 h-3" /> {fmtTime(cl.start)}
                    </button>
                  ))}
                  {!c.clips.length && (
                    <span className="text-xs text-muted-foreground">no clean 8 s sample</span>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <Input
                  value={names[c.diar] ?? ''}
                  onChange={(e) => setNames({ ...names, [c.diar]: e.target.value })}
                  placeholder="Name"
                  className="h-9 text-sm"
                  aria-label={`Name for ${c.label}`}
                />
                <select
                  value={sameAs[c.diar] ?? ''}
                  onChange={(e) => setSameAs({ ...sameAs, [c.diar]: e.target.value })}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  aria-label={`${c.label} is the same person as`}
                >
                  <option value="">same person as…</option>
                  {detail.clusters
                    .filter((o) => o.diar !== c.diar)
                    .map((o) => (
                      <option key={o.diar} value={o.diar}>
                        {o.label}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          ))}
          <Button disabled={busy} onClick={saveNaming}>
            {busy ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <Check className="w-4 h-4 mr-1" />
            )}{' '}
            Save names and start judging
          </Button>
        </div>
      )}

      {!showResults && detail && step === 'items' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">2. Judge the line ({detail.meeting.title})</h2>
            <div className="flex items-center gap-3">
              <button
                className="text-xs underline text-muted-foreground"
                onClick={() => setStep('naming')}
              >
                Edit names
              </button>
              <span className="text-sm tabular-nums text-muted-foreground">
                {Math.min(idx + 1, detail.items.length)} / {detail.items.length} · {done} done
              </span>
            </div>
          </div>
          {!item ? (
            <div className="rounded-xl border border-border bg-card p-6 text-center">
              <p className="font-medium mb-1">All lines of this meeting are judged.</p>
              <Button variant="outline" size="sm" onClick={() => setShowResults(true)}>
                See results
              </Button>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card p-4 space-y-4">
              <div className="flex items-center gap-3 flex-wrap">
                <Button onClick={() => play(item.start, item.end, 1)} variant="outline" size="sm">
                  <Play className="w-4 h-4 mr-1" /> Play (P)
                </Button>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {fmtTime(item.start)}, {Math.round((item.end - item.start) * 10) / 10} s
                </span>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">The line is attributed to</p>
                <p className="text-xl font-semibold">{item.assigned}</p>
              </div>
              <div className="text-sm leading-relaxed">
                <p>{item.textRoman}</p>
                {item.textNative && item.textNative !== item.textRoman && (
                  <p className="text-muted-foreground mt-1">{item.textNative}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Is it that person speaking?</p>
                <Choice
                  name="Speaker"
                  options={SPEAKER}
                  value={item.speaker}
                  onPick={(v) => answer({ speaker: v })}
                />
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Does the text match what you hear?</p>
                <Choice
                  name="Text"
                  options={TEXT}
                  value={item.text}
                  onPick={(v) => answer({ text: v })}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
