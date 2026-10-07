import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Play,
  Check,
  AlertTriangle,
  Loader2,
  Users,
  Link2,
  GitMerge,
  ScanFace,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { api } from '@/api/client';
import { fmtTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const STATUS = {
  solid: { label: 'Confident', cls: 'bg-emerald-100 text-emerald-700' },
  review: { label: 'Needs review', cls: 'bg-amber-100 text-amber-800' },
  new: { label: 'New voice', cls: 'bg-sky-100 text-sky-700' },
  manual: { label: 'Edited by hand', cls: 'bg-violet-100 text-violet-700' },
};

const PALETTE = [
  'bg-blue-100 text-blue-700',
  'bg-emerald-100 text-emerald-700',
  'bg-purple-100 text-purple-700',
  'bg-rose-100 text-rose-700',
  'bg-cyan-100 text-cyan-700',
  'bg-indigo-100 text-indigo-700',
];
export function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function fmtSec(s) {
  const m = Math.round(s / 60);
  return m >= 1 ? `${m} min` : `${Math.round(s)} s`;
}

function SpeakerCardView({ meetingId, card, others, onPlay, onChanged }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [similar, setSimilar] = useState(null);
  const [mergeInto, setMergeInto] = useState('');
  const [note, setNote] = useState('');
  const status = STATUS[card.status] ?? STATUS.new;

  const save = async (extra = {}) => {
    const value = (extra.name ?? name).trim();
    if (!value) return;
    setBusy(true);
    setError('');
    setNote('');
    try {
      const r = await api.meetings.nameSpeaker(meetingId, card.diar, { name: value, ...extra });
      if (r.similar) {
        setSimilar({ typed: value, options: r.similar });
        return;
      }
      setSimilar(null);
      setName('');
      const n = (r.updatedMeetings ?? []).filter((m) => m !== meetingId).length;
      setNote(n > 0 ? `Also updated in ${n} other meeting${n > 1 ? 's' : ''}.` : '');
      await onChanged();
    } catch (e) {
      setError(e?.message || 'Could not save the name.');
    } finally {
      setBusy(false);
    }
  };

  const merge = async () => {
    if (!mergeInto) return;
    setBusy(true);
    setError('');
    try {
      await api.meetings.mergeSpeakers(meetingId, card.diar, mergeInto);
      setMergeInto('');
      await onChanged();
    } catch (e) {
      setError(e?.message || 'Could not merge.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-3 space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`text-xs font-semibold px-2 py-0.5 rounded-full ${colorFor(card.displayName)}`}
        >
          {card.displayName}
        </span>
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${status.cls}`}>
          {status.label}
        </span>
        <span className="text-xs text-muted-foreground ml-auto tabular-nums">
          {fmtSec(card.speakerSec)} of speech
        </span>
      </div>

      {card.match && (
        <p className="text-xs text-foreground flex items-start gap-1.5">
          <Link2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-600" />
          <span>
            Same voice as <b>{card.match.name}</b> · match score {card.match.score}
            <span className="text-muted-foreground">
              {' '}
              (next best is {Math.round(card.match.score - card.match.margin)})
            </span>
          </span>
        </p>
      )}
      {!card.match && card.candidate && (
        <p className="text-xs text-muted-foreground flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600" />
          <span>
            Closest known voice: {card.candidate.name} (score {card.candidate.score}), not confident
            enough to link.
          </span>
        </p>
      )}
      {card.appearsIn.length > 0 && (
        <p className="text-xs text-muted-foreground flex items-start gap-1.5">
          <Users className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Also heard in{' '}
            {card.appearsIn.map((a, i) => (
              <span key={a.meetingId}>
                {i > 0 && ', '}
                <Link to={`/meetings/${a.meetingId}`} className="underline">
                  {a.title}
                </Link>{' '}
                as {a.label}
                {a.score != null ? ` (${a.score})` : ''}
              </span>
            ))}
          </span>
        </p>
      )}

      {card.clips.length > 0 ? (
        <div className="flex gap-1.5 flex-wrap">
          {card.clips.map((c, i) => (
            <button
              key={i}
              onClick={() => onPlay(c.start, c.end)}
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-border hover:bg-secondary"
              aria-label={`Play sample ${i + 1} of ${card.displayName}`}
            >
              <Play className="w-3 h-3" /> {fmtTime(c.start)} · {Math.round(c.end - c.start)} s
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No clean single-speaker sample of 6 s or more.
        </p>
      )}

      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder={card.anonymous ? "Type this person's name" : `Rename ${card.displayName}`}
          className="h-9 text-sm"
          aria-label={`Name for ${card.displayName}`}
        />
        <Button size="sm" disabled={busy || !name.trim()} onClick={() => save()}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          <span className="ml-1">Save</span>
        </Button>
      </div>

      {similar && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-xs space-y-2">
          <p className="text-amber-900">
            “{similar.typed}” looks like someone you already have. Is it the same person?
          </p>
          <div className="flex gap-1.5 flex-wrap">
            {similar.options.map((o) => (
              <Button
                key={o.id}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => save({ name: similar.typed, usePersonId: o.id })}
              >
                Yes, {o.name}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => save({ name: similar.typed, createNew: true })}
            >
              No, a different person
            </Button>
          </div>
        </div>
      )}

      {others.length > 0 && (
        <div className="flex gap-2 items-center">
          <select
            value={mergeInto}
            onChange={(e) => setMergeInto(e.target.value)}
            className="h-8 text-xs rounded-md border border-input bg-background px-2 flex-1"
            aria-label={`Merge ${card.displayName} into`}
          >
            <option value="">Same person as…</option>
            {others.map((o) => (
              <option key={o.diar} value={o.diar}>
                {o.displayName}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" disabled={busy || !mergeInto} onClick={merge}>
            <GitMerge className="w-3.5 h-3.5 mr-1" /> Merge
          </Button>
        </div>
      )}

      {note && <p className="text-xs text-emerald-700">{note}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** Speaker cards for one meeting: samples to listen to, who the voice matches, rename / merge. */
export default function SpeakerReview({ meetingId, source, cards, onPlay, onChanged }) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const reidentify = async () => {
    setBusy(true);
    setMessage('');
    try {
      const r = await api.meetings.reidentify(meetingId);
      setMessage(
        r.changes.length
          ? `Updated ${r.changes.map((c) => `${c.speaker} → ${c.person} (${c.score})`).join(', ')}.`
          : "Checked against today's voiceprints: nothing changed.",
      );
      await onChanged();
    } catch (e) {
      setMessage(e?.message || 'Re-identify failed.');
    } finally {
      setBusy(false);
    }
  };

  if (!cards?.length) return null;
  return (
    <section className="mb-6" aria-label="Speakers">
      <div className="flex items-center justify-between mb-2 gap-2">
        <button
          className="flex items-center gap-2 font-semibold"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <ScanFace className="w-4 h-4 text-muted-foreground" />
          Speakers ({cards.length})
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        {open && source === 'pyannote' && (
          <Button size="sm" variant="outline" disabled={busy} onClick={reidentify}>
            {busy ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <ScanFace className="w-4 h-4 mr-1" />
            )}
            Re-identify speakers
          </Button>
        )}
      </div>
      {open && (
        <div className="space-y-3">
          {source !== 'pyannote' && (
            <p className="text-xs rounded-lg bg-amber-50 border border-amber-200 text-amber-900 p-2.5">
              These speaker labels come from matching text between recording chunks, not from
              voices. They can be wrong.
            </p>
          )}
          {message && <p className="text-xs text-muted-foreground">{message}</p>}
          {cards.map((c) => (
            <SpeakerCardView
              key={c.diar}
              meetingId={meetingId}
              card={c}
              others={cards.filter((o) => o.diar !== c.diar)}
              onPlay={onPlay}
              onChanged={onChanged}
            />
          ))}
          <p className="text-[11px] text-muted-foreground">
            Naming a voice names it everywhere it was recognised. Click a speaker's name on a
            transcript line to move that line or split the speaker from there.
          </p>
        </div>
      )}
    </section>
  );
}
